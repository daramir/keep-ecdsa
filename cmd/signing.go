package cmd

import (
	"context"
	"encoding/hex"
	"fmt"
	"io/ioutil"
	"os"
	"sync"
	"time"

	"github.com/keep-network/keep-core/pkg/net"
	"github.com/keep-network/keep-core/pkg/net/key"
	"github.com/keep-network/keep-core/pkg/net/local"
	"github.com/keep-network/keep-ecdsa/pkg/ecdsa"
	"github.com/keep-network/keep-ecdsa/pkg/ecdsa/tss"

	"github.com/ethereum/go-ethereum/common"
	"github.com/keep-network/keep-common/pkg/chain/ethereum/ethutil"
	"github.com/keep-network/keep-common/pkg/persistence"
	"github.com/keep-network/keep-ecdsa/internal/config"
	"github.com/keep-network/keep-ecdsa/pkg/registry"
	"github.com/urfave/cli"
)

// SigningCommand contains the definition of the `signing` command-line
// subcommand and its own subcommands.
var SigningCommand cli.Command

func init() {
	SigningCommand = cli.Command{
		Name:  "signing",
		Usage: "Provides several tools useful for out-of-band signing",
		Subcommands: []cli.Command{
			{
				Name: "decrypt-key-share",
				Usage: "Decrypts the key share of the operator for the given " +
					"keep and stores it in a file",
				ArgsUsage: "[keep-address]",
				Action:    DecryptKeyShare,
			},
			{
				Name:   "sign-digest",
				Usage:  "Sign a given digest using provided key shares",
				Action: SignDigest,
				Flags: []cli.Flag{
					cli.StringFlag{
						Name: "digest,d",
						Usage: "digest to sign in hex format without " +
							"the `0x` prefix",
					},
					cli.StringFlag{
						Name: "key-shares-dir,k",
						Usage: "directory containing the key shares which " +
							"should be used for signing",
					},
				},
			},
		},
	}
}

// DecryptKeyShare decrypt key shares for given keep using provided operator config.
func DecryptKeyShare(c *cli.Context) error {
	config, err := config.ReadConfig(c.GlobalString("config"))
	if err != nil {
		return fmt.Errorf("failed while reading config file: [%v]", err)
	}

	keyFile, err := ethutil.DecryptKeyFile(
		config.Ethereum.Account.KeyFile,
		config.Ethereum.Account.KeyFilePassword,
	)
	if err != nil {
		return fmt.Errorf("failed to decrypt key file: [%v]", err)
	}

	keepAddressHex := c.Args().First()
	if !common.IsHexAddress(keepAddressHex) {
		return fmt.Errorf("invalid keep address")
	}

	keepAddress := common.HexToAddress(keepAddressHex)

	handle, err := persistence.NewDiskHandle(config.Storage.DataDir)
	if err != nil {
		return fmt.Errorf(
			"failed while creating a storage disk handler: [%v]",
			err,
		)
	}

	persistence := persistence.NewEncryptedPersistence(
		handle,
		config.Ethereum.Account.KeyFilePassword,
	)

	keepRegistry := registry.NewKeepsRegistry(persistence)

	keepRegistry.LoadExistingKeeps()

	signers, err := keepRegistry.GetSigners(keepAddress)
	if err != nil {
		return fmt.Errorf(
			"no signers for keep [%s]: [%v]",
			keepAddress.String(),
			err,
		)
	}

	signer := signers[0]

	signerBytes, err := signer.Marshal()
	if err != nil {
		return fmt.Errorf(
			"failed to marshall signer for keep [%s]: [%v]",
			keepAddress.String(),
			err,
		)
	}

	targetFilePath := fmt.Sprintf(
		"key_share_%.10s_%.10s",
		keepAddress.String(),
		keyFile.Address.String(),
	)

	if _, err := os.Stat(targetFilePath); !os.IsNotExist(err) {
		return fmt.Errorf(
			"could not write shares to file; file [%s] already exists",
			targetFilePath,
		)
	}

	err = ioutil.WriteFile(targetFilePath, signerBytes, 0444) // read-only
	if err != nil {
		return fmt.Errorf(
			"failed to write to file [%s]: [%v]",
			targetFilePath,
			err,
		)
	}

	logger.Infof(
		"key share has been decrypted successfully and written to file [%s]",
		targetFilePath,
	)

	return nil
}

// SignDigest signs a given digest using key shares from the provided directory.
func SignDigest(c *cli.Context) error {
	digest := c.String("digest")
	if len(digest) == 0 {
		return fmt.Errorf("invalid digest")
	}

	keySharesDir := c.String("key-shares-dir")
	if len(keySharesDir) == 0 {
		return fmt.Errorf("invalid key shares directory name")
	}

	keySharesFiles, err := ioutil.ReadDir(keySharesDir)
	if err != nil {
		return fmt.Errorf(
			"could not read key shares directory: [%v]",
			err,
		)
	}

	signers := make([]tss.ThresholdSigner, len(keySharesFiles))
	networkProviders := make([]net.Provider, len(keySharesFiles))

	for i, keyShareFile := range keySharesFiles {
		keyShareBytes, err := ioutil.ReadFile(
			fmt.Sprintf("%s/%s", keySharesDir, keyShareFile.Name()),
		)
		if err != nil {
			return fmt.Errorf(
				"could not read key share file [%v]: [%v]",
				keyShareFile.Name(),
				err,
			)
		}

		var signer tss.ThresholdSigner
		err = signer.Unmarshal(keyShareBytes)
		if err != nil {
			return fmt.Errorf(
				"could not unmarshal signer from file [%v]: [%v]",
				keyShareFile.Name(),
				err,
			)
		}

		operatorPublicKey, err := signer.MemberID().PublicKey()
		if err != nil {
			return fmt.Errorf(
				"could not get operator public key: [%v]",
				err,
			)
		}

		networkKey := key.NetworkPublic(*operatorPublicKey)
		networkProvider := local.ConnectWithKey(&networkKey)

		signers[i] = signer
		networkProviders[i] = networkProvider
	}

	digestBytes, err := hex.DecodeString(digest)
	if err != nil {
		return fmt.Errorf("could not decode digest string: [%v]", err)
	}

	ctx, cancelCtx := context.WithTimeout(
		context.Background(),
		1*time.Minute,
	)
	defer cancelCtx()

	var waitGroup sync.WaitGroup
	waitGroup.Add(len(signers))

	type signingOutcome struct {
		signerIndex int
		signature   *ecdsa.Signature
		err         error
	}

	signingOutcomesChannel := make(chan *signingOutcome, len(signers))

	for i := range signers {
		go func(signerIndex int) {
			defer waitGroup.Done()

			signature, err := signers[signerIndex].CalculateSignature(
				ctx,
				digestBytes,
				networkProviders[signerIndex],
			)

			signingOutcomesChannel <- &signingOutcome{
				signerIndex,
				signature,
				err,
			}
		}(i)
	}

	waitGroup.Wait()
	close(signingOutcomesChannel)

	for signingOutcome := range signingOutcomesChannel {
		if signingOutcome.err != nil {
			logger.Errorf(
				"[signer:%v] error: [%v]",
				signingOutcome.signerIndex,
				signingOutcome.err,
			)
			continue
		}

		logger.Infof(
			"[signer:%v] signature: [%+v]",
			signingOutcome.signerIndex,
			signingOutcome.signature,
		)
	}

	logger.Infof("signing completed")

	return nil
}
