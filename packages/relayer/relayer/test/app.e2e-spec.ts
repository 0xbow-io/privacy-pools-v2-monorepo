/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars */
import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { Address, createWalletClient, Hex, http, publicActions, WalletClient } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { EvmWithdrawalQuoteRequestDto } from "../src/dto/quote.dto";
import { Wei } from "../src/quote/evm/unit.types";
import { ISignedWithdrawalFeeCommitment } from "../src/relayer.types";
import { AppModule } from "./../src/app.module";

// Enable BigInt JSON serialization globally
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
    return this.toString();
};

const ANVIL_PUBKEY: `0x${string}` = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_PRIVKEY: `0x${string}` = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const eth_address: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const FEE_RECEIVER: string = (process.env.FEE_RECEIVER_11155111 as `0x${string}`) || ANVIL_PRIVKEY;

const feeReceiverAddress: Address = (process.env.FEE_RECEIVER_ADDRESS_EVM_11155111 as `0x${string}`) || ANVIL_PUBKEY;
const ETHEREUM_CHAIN_ID: string = process.env.ETHEREUM_CHAIN_ID || "1";

//TODO should investigate this later, we could probably re-do some of the env reading on relayer-config if these are set correctly
// First anvil private key
const WITHDRAWAL_RECEIVER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const WITHDRAWAL_RECEIVER_PKEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const RELAY_CONTRACT: string | undefined = process.env.RELAY_CONTRACT_11155111;
if (!RELAY_CONTRACT) {
    throw new Error(
        "Please provide the deployed address of the contract as an environment variable with name CONTRACT"
    );
}

const RPC_URL = process.env.RPC_URL_EVM_11155111;

if (!RPC_URL) {
    throw new Error("Parameterize rpc url using env variable RPC_URL_EVM_11155111");
}

async function initializeWallet(rpcUrl: string, privateKey) {
    return createWalletClient({
        account: privateKeyToAddress(privateKey),
        key: privateKey,
        transport: http(rpcUrl),
    }).extend(publicActions);
}

const payloadAmountOut = "1001726373953281000"; // 100_000_000_000_000_000 in hex

// Proof in snarkjs format (input format before transformation - hex strings)
const exampleWithdrawalPayload = {
    inputNullifierNumber: 1,
    outputCommitmentNumber: 1,
    proof: {
        pi_a: ["0x1", "0x2", "0x1"],
        pi_b: [
            ["0x2", "0x1"], // Elements are swapped during transform
            ["0x2", "0x1"],
            ["0x1", "0x0"],
        ],
        pi_c: ["0x1", "0x2", "0x1"],
        publicSignals: [
            "0x1234", // nullifierHash
            "0x5678", // outputCommitment
            "0x1", // stateRoot
            "0x2", // keyRegistryRoot
            "0x3", // associationSetRoot
            payloadAmountOut, // amountOut
            eth_address, // tokenIdOut (already a hex string address)
            "0x6", // context
        ],
    },
    noteData: [
        {
            data: "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000000000",
            hint: "0x5465737456616c75654f66427974657333323332333233323332333233323332",
        },
    ],
    recipient: WITHDRAWAL_RECEIVER,
};

describe("AppController (e2e)", () => {
    let app: INestApplication<App>;
    let feeReceiverWallet: WalletClient;
    let transferReceiverWallet: WalletClient;

    beforeEach(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        feeReceiverWallet = await initializeWallet(RPC_URL, FEE_RECEIVER);
        transferReceiverWallet = await initializeWallet(RPC_URL, WITHDRAWAL_RECEIVER_PKEY);
        await app.init();
    });

    const bodyAmount = Wei(1_000_000_000_000_000_000n);
    const quotePayload: EvmWithdrawalQuoteRequestDto = {
        asset: eth_address,
        extraGas: true,
        recipient: WITHDRAWAL_RECEIVER,
        amount: bodyAmount,
        commit: true,
    };

    describe("quoting", () => {
        it("Generates a fee commitment for a non exact withdrawal.", async () => {
            // Notice "send" implies the amount is the total we send.
            const sendApiEndpoint = `/quote/evm/${ETHEREUM_CHAIN_ID}/send`;
            const commitmentResponse = await request(app.getHttpServer())
                .post(sendApiEndpoint)
                .send(JSON.stringify(quotePayload))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(201);

            expect(commitmentResponse.body).toHaveProperty("txCost");
            const amountSent = BigInt(commitmentResponse.body.amountSent);
            const amountReceived = BigInt(commitmentResponse.body.amountReceived);
            expect(amountReceived).toBeLessThan(amountSent);
            expect(amountReceived).toBeLessThan(bodyAmount);
        });
        it("Generates a fee commitment for an exact withdrawal", async () => {
            // Notice "receive" implies the amount is the final amount received by recipient address, with total sent to be determined.
            const receiveApiEndpoint = `/quote/evm/${ETHEREUM_CHAIN_ID}/receive`;
            const commitmentResponse = await request(app.getHttpServer())
                .post(receiveApiEndpoint)
                .send(JSON.stringify(quotePayload))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(201);

            expect(commitmentResponse.body).toHaveProperty("txCost");
            const amountSent = BigInt(commitmentResponse.body.amountSent);
            const amountReceived = BigInt(commitmentResponse.body.amountReceived);
            expect(amountReceived).toBeLessThan(amountSent);
            expect(bodyAmount).toBeLessThan(amountSent);
        });
    });

    describe("Withdrawal with extra gas", () => {
        it("Withdrawal without preexisting feeCommitment.", async () => {
            // Data structure/ ABI obtained from IPrivacyPoolRelay  (FeeSplit)
            const initialBalance = await feeReceiverWallet.getBalance({ address: feeReceiverAddress });
            const initialReceiverBalance: bigint = await transferReceiverWallet.getBalance({
                address: WITHDRAWAL_RECEIVER,
            });

            // This transaction needs a recipient.
            exampleWithdrawalPayload.recipient = WITHDRAWAL_RECEIVER;

            const res = await request(app.getHttpServer())
                .post(`/relay/evm/${ETHEREUM_CHAIN_ID}/withdrawal`)
                .send(JSON.stringify(exampleWithdrawalPayload))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(202);
            const finalBalance = await feeReceiverWallet.getBalance({ address: feeReceiverAddress });
            // console.log(`Transaction completed with txHash = ${res.body.txHash}`);
            expect(res.body).toHaveProperty("txHash");
            const relayerBalanceChange = finalBalance - initialBalance;
            // console.log(
            //     `Initial balance was ${initialBalance}, final was ${finalBalance} (change ${relayerBalanceChange}), address is ${receiverAddress}`
            // );
            expect(relayerBalanceChange).toBeGreaterThan(0n);

            const finalReceiverBalance: bigint = await transferReceiverWallet.getBalance({
                address: WITHDRAWAL_RECEIVER,
            });
            const receiverBalanceChange: bigint = finalReceiverBalance - initialReceiverBalance;
            // console.log(
            //     `Initial RECEIVER balance was ${initialReceiverBalance}, final was ${finalReceiverBalance} (change ${receiverBalanceChange}), address is ${WITHDRAWAL_RECEIVER}`
            // );
            expect(receiverBalanceChange).toBeGreaterThan(0n);
        });

        it("Withdrawal with preexisting feeCommitment.", async () => {
            // Data structure/ ABI obtained from IPrivacyPoolRelay  (FeeSplit)
            const initialBalance = await feeReceiverWallet.getBalance({ address: feeReceiverAddress });
            const initialReceiverBalance = await transferReceiverWallet.getBalance({ address: WITHDRAWAL_RECEIVER });

            const receiveApiEndpoint = `/quote/evm/${ETHEREUM_CHAIN_ID}/receive`;
            const commitmentResponse = await request(app.getHttpServer())
                .post(receiveApiEndpoint)
                .send(JSON.stringify(quotePayload))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(201);
            expect(commitmentResponse.body).toHaveProperty("txCost");

            const signedFeeCommitment: ISignedWithdrawalFeeCommitment = commitmentResponse.body.feeCommitment;

            const exampleWithdrawalPayloadWithCommitment = {
                ...exampleWithdrawalPayload,
                signedFeeCommitment,
            };

            // update proof with the required value (of course, this wouldn't pass actual verification)
            exampleWithdrawalPayloadWithCommitment.proof.publicSignals[5] = signedFeeCommitment.amountSent;

            const res = await request(app.getHttpServer())
                .post(`/relay/evm/${ETHEREUM_CHAIN_ID}/withdrawal`)
                .send(JSON.stringify(exampleWithdrawalPayloadWithCommitment))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(202);
            const finalBalance = await feeReceiverWallet.getBalance({ address: feeReceiverAddress });
            // console.log(`Transaction completed with txHash = ${res.body.txHash}`);
            expect(res.body).toHaveProperty("txHash");
            const relayerBalanceChange = finalBalance - initialBalance;
            console.log(
                `Initial balance was ${initialBalance}, final was ${finalBalance} (change ${relayerBalanceChange}), address is ${feeReceiverAddress}`
            );
            expect(finalBalance).toBeGreaterThan(initialBalance);

            const finalReceiverBalance = await transferReceiverWallet.getBalance({ address: WITHDRAWAL_RECEIVER });
            const receiverBalanceChange = finalReceiverBalance - initialReceiverBalance;
            // console.log(
            //     `Initial withdrawal receiver balance was ${initialReceiverBalance}, final was ${finalReceiverBalance} (change ${receiverBalanceChange}), address is ${WITHDRAWAL_RECEIVER}`
            // );
            expect(finalReceiverBalance).toBeGreaterThan(initialReceiverBalance);
        });
    });

    describe("Withdrawing without extra gas", () => {
        const quotePayloadNoGas = structuredClone(quotePayload);
        quotePayloadNoGas.extraGas = false;
        it("Withdraws when a previous commitment exists.", async () => {
            // Data structure/ ABI obtained from IPrivacyPoolRelay  (FeeSplit)
            const initialBalance = await feeReceiverWallet.getBalance({ address: feeReceiverAddress });
            const initialReceiverBalance = await transferReceiverWallet.getBalance({ address: WITHDRAWAL_RECEIVER });
            const receiveApiEndpoint = `/quote/evm/${ETHEREUM_CHAIN_ID}/receive`;
            const commitmentResponse = await request(app.getHttpServer())
                .post(receiveApiEndpoint)
                .send(JSON.stringify(quotePayloadNoGas))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json");
            // .expect(201)
            expect(commitmentResponse.body).toHaveProperty("txCost");

            const signedFeeCommitment: ISignedWithdrawalFeeCommitment = commitmentResponse.body.feeCommitment;

            const exampleWithdrawalPayloadWithCommitment = {
                ...exampleWithdrawalPayload,
                signedFeeCommitment,
            };

            // update proof with the required value (of course, this wouldn't pass actual verification)
            exampleWithdrawalPayloadWithCommitment.proof.publicSignals[5] = signedFeeCommitment.amountSent;

            const res = await request(app.getHttpServer())
                .post(`/relay/evm/${ETHEREUM_CHAIN_ID}/withdrawal`)
                .send(JSON.stringify(exampleWithdrawalPayloadWithCommitment))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(202);
            const finalBalance = await feeReceiverWallet.getBalance({ address: feeReceiverAddress });
            // console.log(`Transaction completed with txHash = ${res.body.txHash}`);
            expect(res.body).toHaveProperty("txHash");
            const relayerBalanceChange = finalBalance - initialBalance;
            console.log(
                `Initial balance was ${initialBalance}, final was ${finalBalance} (change ${relayerBalanceChange}), address is ${feeReceiverAddress}`
            );
            expect(finalBalance).toBeGreaterThan(initialBalance);

            const finalReceiverBalance = await transferReceiverWallet.getBalance({ address: WITHDRAWAL_RECEIVER });
            const receiverBalanceChange = finalReceiverBalance - initialReceiverBalance;
            console.log(
                `Initial withdrawal receiver balance was ${initialReceiverBalance}, final was ${finalReceiverBalance} (change ${receiverBalanceChange}), address is ${WITHDRAWAL_RECEIVER}`
            );
            expect(finalReceiverBalance).toBeGreaterThan(initialReceiverBalance);
        });
    });

    describe("Transfer", () => {
        it("Rejects if commitment is missing.", async () => {
            // async function tryWithoutCommitment() {
            const res = await request(app.getHttpServer())
                .post(`/relay/evm/${ETHEREUM_CHAIN_ID}/transfer`)
                .send(JSON.stringify(exampleWithdrawalPayload))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(400);
            const errorMessage = JSON.parse(res.error.text).message.signedFeeCommitment;
            expect(errorMessage).toBe(
                "Transfer requires a previously acquired signed fee commitment. Please quote first using the `quote` endpoint."
            );
        });
        it("Accepts if commitment is delivered.", async () => {
            // async function tryWithoutCommitment() {
            const quotePayloadNoGas = structuredClone(quotePayload);
            quotePayloadNoGas.extraGas = false;
            const quoteTransferEndpoint = `/quote/evm/${ETHEREUM_CHAIN_ID}/transfer`;
            const commitmentResponse = await request(app.getHttpServer())
                .post(quoteTransferEndpoint)
                .send(JSON.stringify(quotePayloadNoGas))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(201);
            expect(commitmentResponse.body).toHaveProperty("txCost");

            const signedFeeCommitment: ISignedWithdrawalFeeCommitment = commitmentResponse.body.feeCommitment;

            const exampleTransferPayloadWithCommitment = {
                ...exampleWithdrawalPayload,
                signedFeeCommitment,
            };
            const res = await request(app.getHttpServer())
                .post(`/relay/evm/${ETHEREUM_CHAIN_ID}/transfer`)
                .send(JSON.stringify(exampleTransferPayloadWithCommitment))
                .set("Content-Type", "application/json")
                .set("Accept", "application/json")
                .expect(202);
        });
    });
});
