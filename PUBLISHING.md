# Publishing `wbxsandbox` to npm

The package is published from the standalone repository
**github.com/WBX-Sandbox/wbxsandbox-js** (the contents of `sdk/typescript` copied as the
repository root) by the workflow `.github/workflows/release.yml`, using **npm trusted
publishing**: GitHub Actions proves its identity to npm with a short-lived OIDC token, so no
npm token is stored anywhere. Every release also gets a provenance attestation (a public,
verifiable link between the package and the commit and workflow that built it).

After the one-time setup below, a release is: **GitHub → Releases → Draft a new release →
tag `vX.Y.Z` → Publish release.** Nothing else.

## Requirements (from the npm documentation)

- npm CLI **11.5.1 or newer** in the workflow (npm documents 11.5.0+ as the minimum; the
  workflow installs the current npm 11 because Node.js 22 ships npm 10).
- The job must have the permission **`id-token: write`** (set in `release.yml`).
- **GitHub-hosted runners** only (`runs-on: ubuntu-latest`); self-hosted runners are not supported.
- The trusted publisher is configured per package on npmjs.com with the GitHub owner, the
  repository and the **exact workflow file name** (`release.yml`, case-sensitive), optionally an
  environment name.
- Provenance is generated automatically for trusted publishing from a **public** repository
  of a **public** package. `repository.url` in `package.json` must point to the same GitHub
  repository (`git+https://github.com/WBX-Sandbox/wbxsandbox-js.git`) or npm rejects the
  provenance.
- **The package must already exist on npm before a trusted publisher can be configured.**
  Trusted publishing therefore cannot make the very first publication of a new package name –
  version 0.1.0 needs a one-time bootstrap (step 4).

## One-time setup

### 1. npm account (npmjs.com, in the browser)

1. Sign in (or create the account that will own the package). Use an account name that does
   not reveal anything you do not want public – the owner is shown on the package page.
2. **Account → Two-Factor Authentication**: enable 2FA (required for publishing and for
   managing trusted publishers).
3. Optional but recommended: **create an organization** `wbx-sandbox` (free for public
   packages) so the package belongs to the organization rather than a person.
4. Check that the name is still free: <https://www.npmjs.com/package/wbxsandbox> must say
   "not found".

### 2. GitHub repository (github.com, in the browser)

1. Create the **public** repository `WBX-Sandbox/wbxsandbox-js` and push the contents of
   `sdk/typescript` as its root (including `.github/workflows/`, `package-lock.json`, but not
   `node_modules/` or `dist/` – `.gitignore` takes care of that).
2. **Settings → Actions → General**: allow GitHub Actions.
3. Optional approval gate: **Settings → Environments → New environment** named **`npm`**
   (the name used in `release.yml`) and add yourself as a **required reviewer** – every
   release then waits for one click on "Approve and deploy". Without this the environment is
   created automatically on the first run and has no protection.
4. Check that the **CI** workflow ran green on the main branch (Actions tab).

### 3. Make sure the version is right

`version` in `package.json` and `VERSION` in `src/version.ts` must both be the version you
release (`0.1.0` for the first one), and `CHANGELOG.md` should have its section. The release
workflow refuses a tag that does not match.

### 4. First publication (bootstrap – only for version 0.1.0)

Choose **one** of the two options.

**Option A – publish once from a computer (recommended, takes 2 minutes):**

```sh
git clone https://github.com/WBX-Sandbox/wbxsandbox-js && cd wbxsandbox-js
npm ci && npm run build && npm test
npm login            # opens the browser, confirm with 2FA
npm publish --access public
```

Then create the GitHub release `v0.1.0` anyway (for the changelog); its workflow run will fail
on `npm publish` with "cannot publish over the previously published version" – that is
expected. Continue with step 5.

**Option B – only in the browser (temporary token):**

1. npmjs.com → your avatar → **Access Tokens → Generate New Token → Granular Access Token**:
   name `wbxsandbox-bootstrap`, expiration **7 days**, **Packages and scopes: Read and
   write**, scope **All packages** (the package does not exist yet), check **Bypass
   two-factor authentication**, Generate, copy the token.
2. GitHub → repository → **Settings → Secrets and variables → Actions → New repository
   secret**: name **`NPM_BOOTSTRAP_TOKEN`**, value = the token.
3. Release `v0.1.0` as described in [Every release](#every-release). npm falls back to the
   token because no trusted publisher exists yet. npm accepts the first version of a new
   package from a token only as a **staged** release, so the workflow runs
   `npm stage publish` for it.
4. npmjs.com → your avatar → **Staged Packages** → `wbxsandbox` → **Approve** (confirm with
   2FA). Only then is the version public.
5. Right after it is published: **delete the secret** in GitHub and **delete the token** on
   npmjs.com (Access Tokens → the token → Delete).

Note: npm announced that 2FA-bypass tokens lose the right to publish directly (target:
January 2027). Staging plus approval in the browser keeps working; if option B is refused,
use option A.

### 5. Configure the trusted publisher (npmjs.com, in the browser)

1. Open <https://www.npmjs.com/package/wbxsandbox> → **Settings**.
2. **Trusted Publisher → GitHub Actions** and fill in exactly:
   - Organization or user: `WBX-Sandbox`
   - Repository: `wbxsandbox-js`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
3. Save (confirm with 2FA).
4. Same page, **Publishing access**: choose **"Require two-factor authentication and
   disallow tokens"**. Trusted publishing keeps working; any leaked token becomes useless.

From now on no token exists anywhere.

## Every release

1. Make sure `main` contains the new version in `package.json` and `src/version.ts` and the
   changelog entry, and that CI is green.
2. GitHub → repository → **Releases → Draft a new release**.
3. **Choose a tag** → type `vX.Y.Z` (exactly the version, with `v`) → **Create new tag on
   publish**; target `main`.
4. Title `vX.Y.Z`, paste the changelog section as the description (or "Generate release notes").
5. Pre-release versions (`0.2.0-beta.1`) are published under the npm tag `next` automatically;
   tick "Set as a pre-release" for them.
6. **Publish release.**

The **Release** workflow then checks the tag against `package.json`, installs, builds, runs
the tests and **stages** the version with provenance (`npm stage publish`).

7. npmjs.com → avatar → **Staged Packages** → `wbxsandbox` → **Approve** (2FA). Only then is
   the version on <https://www.npmjs.com/package/wbxsandbox>, with a "Provenance" badge.

The trusted publisher allows only staged publishing ("Allow npm publish" is off), so even
someone with write access to the GitHub repository cannot publish a version without the
maintainer's 2FA approval.

If the run fails before `npm publish`, nothing was published: fix it, delete the release and
its tag, and create it again. A version number can never be published twice – after a
successful publish, fix problems with a new patch version.

## Troubleshooting

| Error in the workflow | Cause |
| --- | --- |
| `release tag … does not match package.json` | The tag must be `v` + the version in `package.json`. |
| `404 Not Found – PUT https://registry.npmjs.org/wbxsandbox` / `ENEEDAUTH` | No trusted publisher configured (or a field differs: owner, repository, `release.yml`, environment `npm`) and no bootstrap token. |
| `Unable to verify … provenance` / `E422` | `repository.url` in `package.json` does not match the GitHub repository, or the repository is private. |
| `npm ERR! code EOTP` | A token without "bypass 2FA" was used for the bootstrap – use option A. |
| OIDC token request fails | `permissions: id-token: write` is missing, or the job runs on a self-hosted runner. |
