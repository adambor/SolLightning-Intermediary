const {authenticatedLndGrpc} = require('lightning');
const bigDecimal = require("js-big-decimal");
const anchor = require("@project-serum/anchor");
const web3 = require("@solana/web3.js");
const RpcClient = require('bitcoind-rpc');
const bitcoin = require("bitcoinjs-lib");

console.log("lnd connecting...");
const {lnd} = authenticatedLndGrpc({
    cert: process.env.LN_CERT,
    macaroon: process.env.LN_MACAROON,
    socket: process.env.LN_NODE_HOST+':'+process.env.LN_NODE_PORT,
});

const privKey = process.env.SOL_PRIVKEY;
const address = process.env.SOL_ADDRESS;

const _signer = web3.Keypair.fromSecretKey(Buffer.from(privKey, "hex"));

const connection = new web3.Connection(process.env.SOL_RPC_URL, "processed");
const _client = new anchor.AnchorProvider(connection, new anchor.Wallet(_signer), {
    preflightCommitment: "processed"
});

const GRACE_PERIOD = new bigDecimal(60*60); //1 hour
const BITCOIN_BLOCKTIME = new bigDecimal(10*60);
const SAFETY_FACTOR = new bigDecimal(2);
const CHAIN_SEND_SAFETY_FACTOR = new bigDecimal(2);
const NETWORK_FEE_MULTIPLIER = new bigDecimal(1.5);
const MAX_SOL_SKEW = 10*60; //How long to wait to refund back the order after its expiry

const AUTHORIZATION_TIMEOUT = 10*60;

const BASE_FEE = new bigDecimal(10);
const FEE = new bigDecimal(0.003);

const CHAIN_BASE_FEE = new bigDecimal(50);
const CHAIN_FEE = new bigDecimal(0.003);

const NETWORK = bitcoin.networks.testnet;

const WBTC_ADDRESS = new web3.PublicKey(process.env.WBTC_ADDRESS);

const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";

const config = {
    protocol: process.env.BTC_PROTOCOL,
    user: process.env.BTC_RPC_USERNAME,
    pass: process.env.BTC_RPC_PASSWORD,
    host: process.env.BTC_NODE_HOST,
    port: process.env.BTC_PORT,
};

console.log("bitcoind connecting...");
const btcRpc = new RpcClient(config);
console.log("bitcoind connected");

module.exports = {
    lnd,
    _client,
    _signer,
    address,
    GRACE_PERIOD,
    BITCOIN_BLOCKTIME,
    SAFETY_FACTOR,
    AUTHORIZATION_TIMEOUT,
    MAX_SOL_SKEW,
    BASE_FEE,
    FEE,
    WBTC_ADDRESS,
    STATE_SEED,
    VAULT_SEED,
    USER_VAULT_SEED,
    AUTHORITY_SEED,
    CHAIN_SEND_SAFETY_FACTOR,
    NETWORK_FEE_MULTIPLIER,
    CHAIN_BASE_FEE,
    CHAIN_FEE,
    NETWORK,
    btcRpc
};