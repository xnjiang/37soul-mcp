# Releasing

This package ships to **two** places:

| Channel | What it feeds | How it gets updated |
| --- | --- | --- |
| npm | `npx 37soul-mcp` — most installs | manually, from your laptop |
| Official MCP Registry | discovery in MCP clients / aggregators | automatically, by CI |

The registry listing was added at 0.4.4. Everything before that shipped to npm
only, so registry-based discovery could not find this server at all. The sibling
`autowhisper-mcp` shows the other failure mode: it *was* listed, but sat on 0.1.0
while npm reached 0.1.4, because the two publishes were independent manual steps.
`.github/workflows/sync-mcp-registry.yml` now keeps this one honest.

## Steps

1. **Bump the version.** It lives in `package.json`, the `MCP_VERSION` constant in
   `src/index.ts`, and twice in `server.json`. The script does all of them and
   fails rather than leave a half-bumped tree:
   ```sh
   ./scripts/bump-version.sh 0.4.5
   ```

2. **Test.**
   ```sh
   npm test    # tsc, then test/smoke.mjs
   ```

3. **Publish to npm.** `cd` here first — `npm publish --prefix` does *not* work,
   it packages the current working directory instead. Expect
   `37soul-mcp@<version>` and `total files: 4`.
   ```sh
   npm publish --access public
   ```

4. **Commit and push.** The push triggers the registry sync, which reads npm's
   `latest` and publishes a matching registry version. Nothing to run by hand.
   ```sh
   git commit -am "release: 0.4.5" && git push origin main
   ```

5. **Confirm both agree** (CI already does this and fails loudly if not):
   ```sh
   npm view 37soul-mcp version
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=37soul" \
     | jq -r '[.servers[]
               | select(._meta["io.modelcontextprotocol.registry/official"].isLatest == true)
               | .server.version][0]'
   ```

## Things that will bite you

- **`mcpName` in `package.json` is the registry's ownership proof.** It must be
  present in the *published* tarball and must equal `name` in `server.json`
  (`io.github.xnjiang/37soul-mcp`). Remove it and the registry stops accepting
  publishes for this package.
- **npm publish order matters.** The registry verifies against the package already
  on npm, so npm goes first. Push second — if you push while `server.json` is
  ahead of npm, CI fails on purpose rather than point the registry at a version
  nobody can install.
- **`description` in `server.json` is capped at 100 characters.** The live
  validator rejects longer, and `mcp-publisher init` happily prefills a longer one
  from `package.json`. Run `mcp-publisher validate` — it checks against the live
  schema, which has migrated before (now camelCase: `registryType`,
  `environmentVariables`, `isRequired`, `isSecret`). Don't guess it locally.
- **`mcp-publisher` via Homebrew is unreliable** — its bottle download has failed
  repeatedly. Grab the binary directly:
  ```sh
  gh release download v1.8.0 --repo modelcontextprotocol/registry --pattern "*darwin_arm64*"
  ```
- **npm 2FA**: this account uses a passkey and npm removed the TOTP option, so
  `--otp` has no code to give. Publishing goes through the browser auth flow the
  CLI offers.

**Verify the CI plumbing any time** without publishing (downloads the publisher,
validates against the live schema, performs the OIDC login, then stops):

```sh
gh workflow run "Sync MCP Registry" -f dry_run=true
```
