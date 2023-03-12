require('dotenv').config();

const anchor = require("@project-serum/anchor");
const web3 = require("@solana/web3.js");

const privKey = process.env.SOL_PRIVKEY;
const address = process.env.SOL_ADDRESS;

const _signer = web3.Keypair.fromSecretKey(Buffer.from(privKey, "hex"));

const connection = new web3.Connection(process.env.SOL_RPC_URL, "processed");
const _client = new anchor.AnchorProvider(connection, new anchor.Wallet(_signer), {
    preflightCommitment: "processed"
});

async function main() {

    let signature = await _client.connection.requestAirdrop(_signer.publicKey, 1500000000);
    const latestBlockhash = await _client.connection.getLatestBlockhash();
    await _client.connection.confirmTransaction(
        {
            signature,
            ...latestBlockhash,
        },
        "confirmed"
    );

    console.log("Airdrop successful, signature: ", signature);

}

main();