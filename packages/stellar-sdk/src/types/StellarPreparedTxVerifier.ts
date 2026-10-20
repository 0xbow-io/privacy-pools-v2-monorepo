/** Configuration for {@link StellarPreparedTxVerifier}. */
export interface StellarPreparedTxVerifierConfig {
    /** The network passphrase transactions were built against — needed to parse the XDR envelope. */
    networkPassphrase: string;
}
