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

const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";
const WBTC_ADDRESS = new web3.PublicKey(process.env.WBTC_ADDRESS);

const programIdl = require("./programIdl");

const program = new anchor.Program(programIdl, programIdl.metadata.address, _client);

const vaultAuthorityKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(AUTHORITY_SEED)],
    program.programId
)[0];

const vaultKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), WBTC_ADDRESS.toBuffer()],
    program.programId
)[0];

const userVaultKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(USER_VAULT_SEED), _signer.publicKey.toBuffer(), WBTC_ADDRESS.toBuffer()],
    program.programId
)[0];

async function main(amount) {
    const ata = await spl_token.getAssociatedTokenAddress(WBTC_ADDRESS, _signer.publicKey);

    let result = await program.methods
        .deposit(new anchor.BN(amount))
        .accounts({
            initializer: _signer.publicKey,
            userData: userVaultKey,
            mint: WBTC_ADDRESS,
            vault: vaultKey,
            vaultAuthority: vaultAuthorityKey,
            initializerDepositTokenAccount: ata,
            systemProgram: web3.SystemProgram.programId,
            rent: web3.SYSVAR_RENT_PUBKEY,
            tokenProgram: spl_token.TOKEN_PROGRAM_ID,
        })
        .signers([_signer])
        .transaction();

    const signature = await _client.sendAndConfirm(result, [_signer]);

    console.log("Deposit sent: ", signature);
}

if(process.argv.length<3) {
    console.error("Needs at least 1 argument");
    console.error("Usage: node deposit.js <amount>");
    return;
}

const amount = parseInt(process.argv[2]);

if(isNaN(amount)) {
    console.error("Invalid amount argument (not a number)");
    return;
}

main(amount);