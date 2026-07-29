#!/usr/bin/env node
// Compiles every contract under contracts/ with the solc npm package (pinned to
// the exact version in package.json) and writes Hardhat-artifact-shaped JSON so
// `hardhat test --no-compile` can pick them straight up. This avoids Hardhat's
// own compiler downloader, which fetches from binaries.soliditylang.org and is
// unreachable in network-restricted environments (e.g. this sandbox) -- solc is
// otherwise a normal npm dependency, fetched from the npm registry like any other.
// Note: this bypasses Hardhat's own compile task, so it doesn't run Typechain --
// test files use the untyped ethers.Contract API rather than generated typings.
"use strict";

const fs = require("fs");
const path = require("path");
const solc = require("solc");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CONTRACTS_DIR = path.join(PROJECT_ROOT, "contracts");
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, "artifacts");
const NODE_MODULES_DIRS = [
  path.join(PROJECT_ROOT, "node_modules"),
  path.join(PROJECT_ROOT, "..", "node_modules"),
];

function listSolFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listSolFiles(full));
    } else if (entry.name.endsWith(".sol")) {
      results.push(full);
    }
  }
  return results;
}

function findImports(importPath) {
  const candidates = [
    path.join(CONTRACTS_DIR, importPath),
    ...NODE_MODULES_DIRS.map((dir) => path.join(dir, importPath)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `File not found: ${importPath}` };
}

function main() {
  const sourceFiles = listSolFiles(CONTRACTS_DIR);
  const sources = {};
  for (const file of sourceFiles) {
    const key = path.relative(CONTRACTS_DIR, file).split(path.sep).join("/");
    sources[key] = { content: fs.readFileSync(file, "utf8") };
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.methodIdentifiers"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  let hasError = false;
  for (const err of output.errors || []) {
    if (err.severity === "error") {
      hasError = true;
      console.error(err.formattedMessage || err.message);
    } else {
      console.warn(err.formattedMessage || err.message);
    }
  }
  if (hasError) {
    process.exit(1);
  }

  for (const [sourceKey, contracts] of Object.entries(output.contracts || {})) {
    const sourceName = `contracts/${sourceKey}`;
    const outDir = path.join(ARTIFACTS_DIR, sourceName);
    fs.mkdirSync(outDir, { recursive: true });

    for (const [contractName, contract] of Object.entries(contracts)) {
      const artifact = {
        _format: "hh-sol-artifact-1",
        contractName,
        sourceName,
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        linkReferences: contract.evm.bytecode.linkReferences || {},
        deployedLinkReferences: contract.evm.deployedBytecode.linkReferences || {},
      };
      fs.writeFileSync(path.join(outDir, `${contractName}.json`), JSON.stringify(artifact, null, 2));
    }
  }

  console.log(`Compiled ${sourceFiles.length} source file(s) with solc ${solc.version()}`);
}

main();
