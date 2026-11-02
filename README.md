# account-lock-explorer

## Requirements

- Bun 1.4.4 or later. Earlier versions trust the compromised eMudhra/emSign root CAs.
- Node.js 26.x (see `.nvmrc`), 26.12.1 or later. Vercel Functions use the `engines.node` value in `package.json`.
- `@solana/web3.js` 1.99.0 or later, to read v1 transactions (SIMD-0385). Every `getBlock` call must send `maxSupportedTransactionVersion: 1`.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.23. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
