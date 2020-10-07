const {accounts, contract, web3} = require("@openzeppelin/test-environment")
const {createSnapshot, restoreSnapshot} = require("../helpers/snapshot")

const {expectRevert, time} = require("@openzeppelin/test-helpers")

const KeepToken = contract.fromArtifact("KeepToken")
const StackLib = contract.fromArtifact("StackLib")
const KeepRegistry = contract.fromArtifact("KeepRegistry")
const BondedECDSAKeepFactoryStub = contract.fromArtifact(
  "BondedECDSAKeepFactoryStub"
)
const KeepBonding = contract.fromArtifact("KeepBonding")
const MinimumStakeSchedule = contract.fromArtifact("MinimumStakeSchedule")
const GrantStaking = contract.fromArtifact("GrantStaking")
const Locks = contract.fromArtifact("Locks")
const TopUps = contract.fromArtifact("TopUps")
const TokenStakingEscrow = contract.fromArtifact("TokenStakingEscrow")
const TokenStaking = contract.fromArtifact("TokenStakingStub")
const TokenGrant = contract.fromArtifact("TokenGrant")
const BondedSortitionPoolFactory = contract.fromArtifact(
  "BondedSortitionPoolFactory"
)
const RandomBeaconStub = contract.fromArtifact("RandomBeaconStub")
const BondedECDSAKeepStub = contract.fromArtifact("BondedECDSAKeepStub")
const ECDSARewards = contract.fromArtifact("ECDSARewards")

const KeepTokenGrant = contract.fromArtifact("TokenGrant")

const BN = web3.utils.BN

const chai = require("chai")
chai.use(require("bn-chai")(BN))
const expect = chai.expect

describe("ECDSARewards", () => {
  let registry
  let rewardsContract
  let keepToken

  let tokenStaking
  let tokenGrant
  let keepFactory
  let bondedSortitionPoolFactory
  let keepBonding
  let randomBeacon
  let keepMembers
  let expectedKEEPAllocation

  const owner = accounts[0]

  const keepSize = 3
  // Solidity is not very good when it comes to floating point precision,
  // we are allowing for ~1 KEEP difference margin between expected and
  // actual value.
  const precision = 1
  const tokenDecimalMultiplier = web3.utils.toBN(10).pow(web3.utils.toBN(18))
  const firstKeepCreationTimestamp = 1600087297 // Sep 14 2020

  // 1,000,000,000 - total KEEP supply
  //   200,000,000 - 20% of the total supply goes to staker rewards
  //   180,000,000 - 90% of staker rewards goes to the ECDSA stakers
  //   178,200,000 - 89% of ECDSA staker rewards goes to keeps opened after Sep 14 2020
  const KEEPRewards = web3.utils.toBN(178200000).mul(tokenDecimalMultiplier)

  before(async () => {
    await BondedSortitionPoolFactory.detectNetwork()
    await BondedSortitionPoolFactory.link(
      "StackLib",
      (await StackLib.new({from: owner})).address
    )

    await initializeNewFactory()
    keepMembers = await createMembers()
    rewardsContract = await ECDSARewards.new(
      keepToken.address,
      keepFactory.address,
      {from: owner}
    )

    await fund(KEEPRewards)
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("interval allocation", async () => {
    expectedKEEPAllocation = [
      7128000.0, 13685760.0, 15738624.0, 16997713.92, 18697485.31, 15892862.52,
      13508933.14, 11482593.17, 9760204.19, 8296173.56, 7051747.53, 5993985.4,
      5094887.59, 4330654.45, 3681056.28, 3128897.84, 2659563.16, 2260628.69,
      1921534.39, 1633304.23, 1388308.59, 1180062.31, 1003052.96, 852595.02
    ]

    it("should equal to expected allocations when 5 keeps were created per interval", async () => {
      await verifyIntervalAllocations(5)
    })

    it("should equal to expected allocations when 1 keep was created per interval", async () => {
      await verifyIntervalAllocations(1)
    })
  })

  async function verifyIntervalAllocations(keepToCreatePerInterval) {
    let keepCreationTimestamp = firstKeepCreationTimestamp

    for (let i = 0; i < 24; i++) {
      await createKeeps(keepToCreatePerInterval, keepCreationTimestamp)

      keepCreationTimestamp = await timeJumpToEndOfInterval(i)

      await rewardsContract.allocateRewards(i)

      const actualBalance = (await rewardsContract.getAllocatedRewards(i)).div(
        tokenDecimalMultiplier
      )

      expect(actualBalance).to.gte.BN(expectedKEEPAllocation - precision)
      expect(actualBalance).to.lte.BN(expectedKEEPAllocation + precision)
    }
  }

  describe("rewards distribution", async () => {
    it("should not be possible when a keep is not closed", async () => {
      await createKeeps(1, firstKeepCreationTimestamp)

      const keepAddress = await keepFactory.getKeepAtIndex(0)

      const isEligible = await rewardsContract.eligibleForReward(keepAddress)
      expect(isEligible).to.be.false

      await timeJumpToEndOfInterval(0)
      await expectRevert(
        rewardsContract.receiveReward(keepAddress),
        "Keep is not closed"
      )
    })

    it("should not be possible when a keep is terminated", async () => {
      await createKeeps(1, firstKeepCreationTimestamp)

      const keepAddress = await keepFactory.getKeepAtIndex(0)
      const keep = await BondedECDSAKeepStub.at(keepAddress)
      await keep.publicMarkAsTerminated()

      const isEligible = await rewardsContract.eligibleForReward(keepAddress)
      expect(isEligible).to.be.false

      await timeJumpToEndOfInterval(0)
      await expectRevert(
        rewardsContract.receiveReward(keepAddress),
        "Keep is not closed"
      )
    })

    it("should not count terminated groups when distributing rewards", async () => {
      await createKeeps(2, firstKeepCreationTimestamp)
      // reward for the first interval: 7128000 KEEP
      // keeps created: 2, but the min is 4 => 7128000 / 4 = 1782000 KEEP per keep
      // member receives: 1782000 / 3 = 594000 (3 signers per keep)
      const expectedBeneficiaryBalance = new BN(594000)

      await timeJumpToEndOfInterval(0)

      const keepTerminatedAddress = await keepFactory.getKeepAtIndex(0)
      const keepTerminated = await BondedECDSAKeepStub.at(keepTerminatedAddress)
      await keepTerminated.publicMarkAsTerminated()

      const keepAddress = await keepFactory.getKeepAtIndex(1)
      const keep = await BondedECDSAKeepStub.at(keepAddress)
      await keep.publicMarkAsClosed()

      await expectRevert(
        rewardsContract.receiveReward(keepTerminatedAddress),
        "Keep is not closed"
      )

      await rewardsContract.receiveReward(keepAddress)
      // Only the second keep was properly closed.
      await assertKeepBalanceOfBeneficiaries(expectedBeneficiaryBalance)

      // the remaining 5346000 stays in unallocated rewards but the fact
      // one keep was terminated needs to be reported to recalculate the 
      // unallocated amount
      let unallocated = await rewardsContract.unallocatedRewards()
      let unallocatedInKeep = unallocated.div(tokenDecimalMultiplier)
      expect(unallocatedInKeep).to.eq.BN(174636000) // 178200000 - (2 * 1782000)

      await rewardsContract.reportTermination(keepTerminatedAddress)

      unallocated = await rewardsContract.unallocatedRewards()
      unallocatedInKeep = unallocated.div(tokenDecimalMultiplier)
      expect(unallocatedInKeep).to.eq.BN(176418000) // 178200000 - 1782000
    })

    it("should correctly distribute rewards between beneficiaries", async () => {
      await createKeeps(8, firstKeepCreationTimestamp)
      // reward for the first interval: 7128000 KEEP
      // keeps created: 8 => 891000 KEEP per keep
      // member receives: 891000 / 3 = 297000 (3 signers per keep)
      const expectedBeneficiaryBalance = new BN(297000)

      await timeJumpToEndOfInterval(0)

      let keepAddress = await keepFactory.getKeepAtIndex(0)
      let keep = await BondedECDSAKeepStub.at(keepAddress)
      await keep.publicMarkAsClosed()

      await rewardsContract.receiveReward(keepAddress)

      await assertKeepBalanceOfBeneficiaries(expectedBeneficiaryBalance)

      // verify second keep in this interval
      keepAddress = await keepFactory.getKeepAtIndex(1)
      keep = await BondedECDSAKeepStub.at(keepAddress)
      await keep.publicMarkAsClosed()

      await rewardsContract.receiveReward(keepAddress)

      // 297000 * 2 = 594000
      await assertKeepBalanceOfBeneficiaries(expectedBeneficiaryBalance.muln(2))
    })
  })

  async function assertKeepBalanceOfBeneficiaries(expectedBalance) {
    for (let i = 0; i < keepMembers.length; i++) {
      const actualBalance = (
        await keepToken.balanceOf(keepMembers[i].beneficiary)
      ).div(tokenDecimalMultiplier)

      expect(actualBalance).to.gte.BN(expectedBalance.subn(precision))
      expect(actualBalance).to.lte.BN(expectedBalance.addn(precision))
    }
  }

  async function initializeNewFactory() {
    await BondedSortitionPoolFactory.detectNetwork()
    await BondedSortitionPoolFactory.link(
      "StackLib",
      (await StackLib.new({from: owner})).address
    )

    keepToken = await KeepToken.new({from: owner})
    const keepTokenGrant = await KeepTokenGrant.new(keepToken.address)
    registry = await KeepRegistry.new({from: owner})

    bondedSortitionPoolFactory = await BondedSortitionPoolFactory.new({
      from: owner,
    })
    await TokenStaking.detectNetwork()
    await TokenStaking.link(
      "MinimumStakeSchedule",
      (await MinimumStakeSchedule.new({from: owner})).address
    )
    await TokenStaking.link(
      "GrantStaking",
      (await GrantStaking.new({from: owner})).address
    )
    await TokenStaking.link("Locks", (await Locks.new({from: owner})).address)
    await TokenStaking.link("TopUps", (await TopUps.new({from: owner})).address)

    const stakingEscrow = await TokenStakingEscrow.new(
      keepToken.address,
      keepTokenGrant.address,
      {from: owner}
    )

    const stakeInitializationPeriod = 30 // In seconds

    tokenStaking = await TokenStaking.new(
      keepToken.address,
      keepTokenGrant.address,
      stakingEscrow.address,
      registry.address,
      stakeInitializationPeriod,
      {from: owner}
    )
    tokenGrant = await TokenGrant.new(keepToken.address, {from: owner})

    keepBonding = await KeepBonding.new(
      registry.address,
      tokenStaking.address,
      tokenGrant.address,
      {from: owner}
    )
    randomBeacon = await RandomBeaconStub.new({from: owner})
    const bondedECDSAKeepMasterContract = await BondedECDSAKeepStub.new({
      from: owner,
    })
    keepFactory = await BondedECDSAKeepFactoryStub.new(
      bondedECDSAKeepMasterContract.address,
      bondedSortitionPoolFactory.address,
      tokenStaking.address,
      keepBonding.address,
      randomBeacon.address,
      {from: owner}
    )

    await registry.approveOperatorContract(keepFactory.address, {from: owner})
  }

  async function createMembers() {
    const membersArr = []

    // 3 members in each keep
    for (let i = 0; i < keepSize; i++) {
      const operator = accounts[i]
      const beneficiary = accounts[keepSize + i]
      await tokenStaking.setBeneficiary(operator, beneficiary)
      const member = {
        operator: operator,
        beneficiary: beneficiary,
      }

      membersArr.push(member)
    }

    return membersArr
  }

  async function createKeeps(numberOfKeepsToOpen, keepCreationTimestamp) {
    let timestamp = new BN(keepCreationTimestamp)
    const members = keepMembers.map((m) => m.operator)
    for (let i = 0; i < numberOfKeepsToOpen; i++) {
      await keepFactory.stubOpenKeep(keepFactory.address, members, timestamp)
      timestamp = timestamp.addn(7200) // adding 2 hours interval between each opened keep
    }
  }

  async function fund(amount) {
    await keepToken.approveAndCall(rewardsContract.address, amount, "0x0", {
      from: owner,
    })
    await rewardsContract.markAsFunded({from: owner})
  }

  async function timeJumpToEndOfInterval(intervalNumber) {
    const endOf = await rewardsContract.endOf(intervalNumber)
    const now = await time.latest()

    if (now.lt(endOf)) {
      await time.increaseTo(endOf.addn(60))
    }

    return await time.latest()
  }
})
