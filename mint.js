require('dotenv').config();

const spl_token = require("@solana/spl-token");
const anchor = require("@project-serum/anchor");
const web3 = require("@solana/web3.js");

const privKey = process.env.SOL_PRIVKEY;
const address = process.env.SOL_ADDRESS;

const _signer = web3.Keypair.fromSecretKey(Buffer.from(privKey, "hex"));

const connection = new web3.Connection(process.env.SOL_RPC_URL, "processed");
const _client = new anchor.AnchorProvider(connection, new anchor.Wallet(_signer), {
    preflightCommitment: "processed"
});

const WBTC_ADDRESS = new web3.PublicKey(process.env.WBTC_ADDRESS);

async function main(amount, acc) {
    const ata = await spl_token.getOrCreateAssociatedTokenAccount(_client.connection, _signer, WBTC_ADDRESS, acc);

    const signature = await spl_token.mintTo(_client.connection, _signer, WBTC_ADDRESS, ata.address, _signer, amount);

    console.log("Mint signature: ", signature);
}

if(process.argv.length<3) {
    console.error("Needs at least 1 argument");
    console.error("Usage: node mint.js <amount> [address (optional)]");
    return;
}

const amount = parseInt(process.argv[2]);

if(isNaN(amount)) {
    console.error("Invalid amount argument (not a number)");
    return;
}

let pubKey = _signer.publicKey;
if(process.argv.length>3) {
    pubKey = new web3.PublicKey(process.argv[3]);
    if(pubKey==null) {
        console.error("Invalid address argument (not a valid solana address)");
        return;
    }
}

main(amount, pubKey);