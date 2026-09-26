# Hugging Face model pack preparation

The public payload is generated from the exact `fretformer-v1-onnx` file list
in `engine/catalog.json`. It includes the model card, licenses, large-file
attributes, and checksums. Preparation never publishes anything.

## Prepare and audit

Install [uv](https://docs.astral.sh/uv/) for the isolated release-time Python
environment. This tooling uses ONNX's protobuf parser and checker to inspect
embedded graph metadata; Python is not an application runtime dependency.

Set `AUTOCHART_PUBLIC_DENY` locally to a comma-separated list of private names,
handles, hostnames, and other identifying strings. Do not put those values in
the model card or upload folder. The local OS username is included automatically.

```bash
uv run scripts/prepare-huggingface.py
```

The default upload folder is:

```text
release-onboarding/huggingface/autochart-models/
```

The script refuses to overwrite an existing folder. Use `--output` for a new
destination, or re-audit an existing payload:

```bash
uv run scripts/prepare-huggingface.py --verify-only
```

Every catalog file must match its pinned bytes. Development symlinks are
materialized as regular files. Unknown files, directories, symlinks, external
ONNX tensor data, unexpected NPZ contents, and privacy findings fail the audit.
All ONNX string fields, including nested graph metadata and string attributes,
are checked. Numeric weights are preserved byte-for-byte. NPZ member names,
headers, archive comments, and metadata are inspected, and the arrays must have
the expected numeric-only layout.

The scan covers configured identifiers (UTF-8/UTF-16 bytes), local paths,
email addresses, IPv4/IPv6 literals, common credentials, private hostnames, and
unreviewed web URLs. It does not infer every possible personal identity or
inspect what a model might have learned. Review the model card as well.
Required upstream authors and institutional attribution remain intact.

A hash-bound audit report is written beside the upload folder, outside its
allowlist. It contains relative payload paths and checks, without private deny
values, local source paths, or machine details.

The synthetic regression probes exercise embedded metadata leaks, compressed
NPZ contents, external tensors, extra files, symlinks, and corrupted hashes:

```bash
uv run scripts/test-huggingface-privacy.py
```

## Create the Hub repository and upload

Use a public **model** repository named `autochart-models`, with gating disabled.
The model card supplies the Fretformer license tag and component-specific MIT
notices. Use a project-facing account/organization and review the publishing
account's public username, display name, profile, and affiliations: the Hub
exposes repository ownership and the authenticated commit author. An
organization alone does not hide the uploading account. Local file scanning
cannot anonymize that hosting identity.

After reviewing the staged payload and publishing identity:

```bash
hf auth login
hf auth whoami
hf upload PUBLIC_NAMESPACE/autochart-models \
  release-onboarding/huggingface/autochart-models . \
  --commit-message "Add Fretformer v1 ONNX model pack"
```

Upload only that folder. It contains no Git history or local audit logs.
The `hf` HTTP upload uses the authenticated Hub account, not the local Git
author configuration. The host can still see connection/account information;
this workflow is about keeping personal details out of the public payload.

## Pin and verify the public source

The current published pack and app default use:

```text
https://huggingface.co/Dvaro/autochart-models/resolve/b38e69ca0dc919cef0218ef7f9c0014a1593b3c2
```

Run the clean-install generation smoke using the app's default:

```bash
npm run smoke:generate -- --wipe
```

For future packs, verify the new upload with `--asset-base-url` before changing
`DEFAULT_ASSET_BASE_URL` in `electron/assetInstaller.cjs`, then update the
installation/release documentation and run the release verification gates.
Model changes require new catalog hashes and a new pinned Hub revision. The
app never trusts a downloaded replacement catalog.
