/**
▓▓▌ ▓▓ ▐▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▄
▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  ▓▓▓▓▓▓    ▓▓▓▓▓▓▓▀    ▐▓▓▓▓▓▓    ▐▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
  ▓▓▓▓▓▓▄▄▓▓▓▓▓▓▓▀      ▐▓▓▓▓▓▓▄▄▄▄         ▓▓▓▓▓▓▄▄▄▄         ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▀        ▐▓▓▓▓▓▓▓▓▓▓         ▓▓▓▓▓▓▓▓▓▓▌        ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  ▓▓▓▓▓▓▀▀▓▓▓▓▓▓▄       ▐▓▓▓▓▓▓▀▀▀▀         ▓▓▓▓▓▓▀▀▀▀         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▀
  ▓▓▓▓▓▓   ▀▓▓▓▓▓▓▄     ▐▓▓▓▓▓▓     ▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌
▓▓▓▓▓▓▓▓▓▓ █▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓

                           Trust math, not hardware.
*/

pragma solidity 0.5.17;

import "./FullyBackedBondedECDSAKeep.sol";

import "./FullyBackedBonding.sol";
import "../api/IBondedECDSAKeepFactory.sol";
import "../KeepCreator.sol";
import "../GroupSelectionSeed.sol";
import "../CandidatesPools.sol";

import {
    AuthorityDelegator
} from "@keep-network/keep-core/contracts/Authorizations.sol";

import "@keep-network/sortition-pools/contracts/api/IFullyBackedBonding.sol";
import "@keep-network/sortition-pools/contracts/FullyBackedSortitionPoolFactory.sol";
import "@keep-network/sortition-pools/contracts/FullyBackedSortitionPool.sol";

import "openzeppelin-solidity/contracts/math/SafeMath.sol";

/// @title Fully Backed Bonded ECDSA Keep Factory
/// @notice Contract creating bonded ECDSA keeps that are fully backed by ETH.
/// @dev We avoid redeployment of bonded ECDSA keep contract by using the clone factory.
/// Proxy delegates calls to sortition pool and therefore does not affect contract's
/// state. This means that we only need to deploy the bonded ECDSA keep contract
/// once. The factory provides clean state for every new bonded ECDSA keep clone.
contract FullyBackedBondedECDSAKeepFactory is
    IBondedECDSAKeepFactory,
    KeepCreator,
    AuthorityDelegator,
    GroupSelectionSeed,
    CandidatesPools
{
    FullyBackedSortitionPoolFactory sortitionPoolFactory;
    FullyBackedBonding bonding;

    using SafeMath for uint256;

    // Sortition pool is created with a minimum bond of 20 ETH to avoid
    // small operators joining and griefing future selections before the
    // minimum bond is set to the right value by the application.
    //
    // Anyone can create a sortition pool for an application with the default
    // minimum bond value but the application can change this value later, at
    // any point.
    uint256 public constant defaultMinimumBond = 20e18; // 20 ETH // TODO: Decide on value

    // Signer candidates in bonded sortition pool are weighted by their eligible
    // stake divided by a constant divisor. The divisor is set to 1 ETH so that
    // all ETHs in available unbonded value matter when calculating operator's
    // eligible weight for signer selection.
    uint256 public constant bondWeightDivisor = 1e18; // 1 ETH // TODO: Decide on value

    // List of applications that got sortition pool created.
    address[] applications;

    // Notification that a new keep has been created.
    event FullyBackedBondedECDSAKeepCreated(
        address indexed keepAddress,
        address[] members,
        address indexed owner,
        address indexed application,
        uint256 honestThreshold
    );

    // Notification when operator gets banned in sortition pools.
    event OperatorBanned(address indexed operator);

    constructor(
        address _masterKeepAddress,
        address _sortitionPoolFactoryAddress,
        address _bondingAddress,
        address _randomBeaconAddress
    )
        public
        KeepCreator(_masterKeepAddress)
        GroupSelectionSeed(_randomBeaconAddress)
    {
        sortitionPoolFactory = FullyBackedSortitionPoolFactory(
            _sortitionPoolFactoryAddress
        );

        bonding = FullyBackedBonding(_bondingAddress);
    }

    /// @notice Sets the minimum bondable value required from the operator to
    /// join the sortition pool of the given application. It is up to the
    /// application to specify a reasonable minimum bond for operators trying to
    /// join the pool to prevent griefing by operators joining without enough
    /// bondable value.
    /// @param _minimumBondableValue The minimum bond value the application
    /// requires from a single keep.
    /// @param _groupSize Number of signers in the keep.
    /// @param _honestThreshold Minimum number of honest keep signers.
    function setMinimumBondableValue(
        uint256 _minimumBondableValue,
        uint256 _groupSize,
        uint256 _honestThreshold
    ) external {
        uint256 memberBond = bondPerMember(_minimumBondableValue, _groupSize);
        FullyBackedSortitionPool(getSortitionPool(msg.sender))
            .setMinimumBondableValue(memberBond);
    }

    /// @notice Opens a new ECDSA keep.
    /// @dev Selects a list of signers for the keep based on provided parameters.
    /// A caller of this function is expected to be an application for which
    /// member candidates were registered in a pool.
    /// @param _groupSize Number of signers in the keep.
    /// @param _honestThreshold Minimum number of honest keep signers.
    /// @param _owner Address of the keep owner.
    /// @param _bond Value of ETH bond required from the keep in wei.
    /// @param _stakeLockDuration Stake lock duration in seconds. Ignored by
    /// this implementation.
    /// @return Created keep address.
    function openKeep(
        uint256 _groupSize,
        uint256 _honestThreshold,
        address _owner,
        uint256 _bond,
        uint256 _stakeLockDuration
    ) external payable nonReentrant returns (address keepAddress) {
        require(_groupSize > 0, "Minimum signing group size is 1");
        require(_groupSize <= 16, "Maximum signing group size is 16");
        require(
            _honestThreshold > 0,
            "Honest threshold must be greater than 0"
        );
        require(
            _honestThreshold <= _groupSize,
            "Honest threshold must be less or equal the group size"
        );

        address application = msg.sender;
        address pool = getSortitionPool(application);

        uint256 memberBond = bondPerMember(_bond, _groupSize);
        require(memberBond > 0, "Bond per member must be greater than zero");

        require(
            msg.value >= openKeepFeeEstimate(),
            "Insufficient payment for opening a new keep"
        );

        address[] memory members = FullyBackedSortitionPool(pool)
            .selectSetGroup(
            _groupSize,
            bytes32(groupSelectionSeed),
            memberBond
        );

        newGroupSelectionSeed();

        // createKeep sets keepOpenedTimestamp value for newly created keep which
        // is required to be set before calling `keep.initialize` function as it
        // is used to determine token staking delegation authority recognition
        // in `__isRecognized` function.
        keepAddress = createKeep();

        FullyBackedBondedECDSAKeep(keepAddress).initialize(
            _owner,
            members,
            _honestThreshold,
            address(bonding),
            address(this)
        );

        for (uint256 i = 0; i < _groupSize; i++) {
            bonding.createBond(
                members[i],
                keepAddress,
                uint256(keepAddress),
                memberBond,
                pool
            );
        }

        emit FullyBackedBondedECDSAKeepCreated(
            keepAddress,
            members,
            _owner,
            application,
            _honestThreshold
        );
    }

    /// @notice Verifies if delegates authority recipient is valid address recognized
    /// by the factory for token staking authority delegation.
    /// @param _delegatedAuthorityRecipient Address of the delegated authority
    /// recipient.
    /// @return True if provided address is recognized delegated token staking
    /// authority for this factory contract.
    function __isRecognized(address _delegatedAuthorityRecipient)
        external
        returns (bool)
    {
        return keepOpenedTimestamp[_delegatedAuthorityRecipient] > 0;
    }

    /// @notice Creates new sortition pool for the application.
    /// @dev Emits an event after sortition pool creation.
    /// @param _application Address of the application.
    /// @return Address of the created sortition pool contract.
    function createSortitionPool(address _application)
        public
        returns (address sortitionPool)
    {
        sortitionPool = super.createSortitionPool(_application);

        applications.push(_application);
    }

    /// @notice Gets a fee estimate for opening a new keep.
    /// @return Uint256 estimate.
    function openKeepFeeEstimate() public view returns (uint256) {
        return newEntryFeeEstimate();
    }

    /// @notice Checks if the factory has the authorization to operate on stake
    /// represented by the provided operator.
    ///
    /// @param _operator operator's address
    /// @return True if the factory has access to the staked token balance of
    /// the provided operator and can slash that stake. False otherwise.
    function isOperatorAuthorized(address _operator)
        public
        view
        returns (bool)
    {
        return bonding.isAuthorizedForOperator(_operator, address(this));
    }

    /// @notice Bans members of a calling keep in all associated sortition pools
    /// for every registered application.
    /// @dev The function can be called only by a keep created by this factory.
    function banKeepMembers() public onlyKeep() {
        FullyBackedBondedECDSAKeep keep = FullyBackedBondedECDSAKeep(
            msg.sender
        );

        address[] memory members = keep.getMembers();

        for (uint256 i = 0; i < members.length; i++) {
            address operator = members[i];

            for (uint256 j = 0; j < applications.length; j++) {
                FullyBackedSortitionPool(getSortitionPool(applications[j])).ban(
                    operator
                );
            }

            emit OperatorBanned(operator);
        }
    }

    function newSortitionPool(address _application) internal returns (address) {
        return
            sortitionPoolFactory.createSortitionPool(
                IFullyBackedBonding(address(bonding)),
                defaultMinimumBond,
                bondWeightDivisor
            );
    }

    /// @notice Calculates bond requirement per member performing the necessary
    /// rounding.
    /// @param _keepBond The bond required from a keep.
    /// @param _groupSize Number of signers in the keep.
    /// @return Bond value required from each keep member.
    function bondPerMember(uint256 _keepBond, uint256 _groupSize)
        internal
        pure
        returns (uint256)
    {
        // In Solidity, division rounds towards zero (down) and dividing
        // '_bond' by '_groupSize' can leave a remainder. Even though, a remainder
        // is very small, we want to avoid this from happening and memberBond is
        // rounded up by: `(bond + groupSize - 1 ) / groupSize`
        // Ex. (100 + 3 - 1) / 3 = 34
        return (_keepBond.add(_groupSize).sub(1)).div(_groupSize);
    }

    /// @notice Checks if caller is a keep created by this factory.
    modifier onlyKeep() {
        require(
            keepOpenedTimestamp[msg.sender] > 0,
            "Caller is not a keep created by the factory"
        );
        _;
    }
}