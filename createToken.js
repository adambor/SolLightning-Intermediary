require('dotenv').config();

const spl_token = require("@solana/spl-token");
const fs = require("fs");
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
    const mint = await spl_token.createMint(_client.connection, _signer, _signer.publicKey, null, 0);

    fs.appendFileSync(".env",
        "WBTC_ADDRESS=\""+mint.toBase58()+"\"\n");

    console.log("Token ID: ", mint);
}

main();