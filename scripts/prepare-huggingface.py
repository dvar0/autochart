#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["onnx==1.22.0"]
# ///
"""Build or audit the exact public model payload; never contacts the Hub."""

import argparse
import ast
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import tempfile
from urllib.parse import urlsplit
import zipfile

import onnx
from google.protobuf.descriptor import FieldDescriptor

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "release-onboarding/huggingface/autochart-models"
ATTRIBUTES = "*.onnx filter=lfs diff=lfs merge=lfs -text\n*.npz filter=lfs diff=lfs merge=lfs -text\n"
ALLOWED_URLS = (
    "https://github.com/facebookresearch/demucs",
    "https://github.com/CPJKU/beat_this",
    "https://creativecommons.org/",
    "http://creativecommons.org/",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def deny_terms():
    # Keep personal identifiers in local environment variables, never in the payload.
    terms = os.environ.get("AUTOCHART_PUBLIC_DENY", "").split(",")
    terms += [os.environ.get("USER", ""), os.environ.get("USERNAME", ""), Path.home().name]
    return sorted({s.strip().casefold() for s in terms if len(s.strip()) >= 3
                   and s.strip().casefold() not in {"root", "user", "runner"}})


def audit_text(text, label, terms):
    require(not any(t in text.casefold() for t in terms), f"{label}: blocked identity")
    patterns = {
        "local path": r"(?i)/(?:home|users|mnt|media|tmp|private|root|workspace|workspaces|var|opt)/|(?<![a-z0-9])[a-z]:[\\/]|\\\\[a-z0-9_.-]+\\|~/",
        "email": r"[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}",
        "credential": r"\b(?:hf_|ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----",
        "local host": r"(?i)\blocalhost\b|\b[a-z0-9-]+\.(?:local|lan|internal)\b",
    }
    for kind, pattern in patterns.items():
        require(not re.search(pattern, text), f"{label}: {kind}")
    for candidate in re.findall(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])|(?<![\w:])[0-9a-fA-F:]*:[0-9a-fA-F:]+(?:%[\w.-]+)?(?![\w:])", text):
        try:
            ipaddress.ip_address(candidate)
        except ValueError:
            continue
        raise ValueError(f"{label}: IP address")
    for url in re.findall(r"https?://[^\s<>\"')]+", text):
        parsed = urlsplit(url)
        require(not parsed.username and not parsed.password and not parsed.query,
                f"{label}: URL credentials or query")
        require(any(url.startswith(prefix) if prefix.endswith("/") else
                    url == prefix or url.startswith(prefix + "/") or url.startswith(prefix + "#")
                    for prefix in ALLOWED_URLS),
                f"{label}: unreviewed URL")


def audit_identity_bytes(data, label, terms):
    lowered = data.lower()
    for encoding in ("utf-8", "utf-16-le", "utf-16-be"):
        require(not any(term.encode(encoding) in lowered for term in terms),
                f"{label}: blocked identity bytes")


def audit_onnx(file, terms):
    model = onnx.load(str(file), load_external_data=False)
    counts = {"textFields": 0, "tensorPayloads": 0}

    def walk(message):
        for field, value in message.ListFields():
            values = value if field.is_repeated else [value]
            for item in values:
                if field.type == FieldDescriptor.TYPE_MESSAGE:
                    walk(item)
                elif field.type == FieldDescriptor.TYPE_STRING:
                    audit_text(item, file.name, terms)
                    counts["textFields"] += 1
                elif field.type == FieldDescriptor.TYPE_BYTES:
                    if field.name == "raw_data":
                        counts["tensorPayloads"] += 1
                    else:
                        audit_text(item.decode("utf-8", errors="strict"), file.name, terms)
                        counts["textFields"] += 1
        if isinstance(message, onnx.TensorProto):
            require(not message.external_data and message.data_location != onnx.TensorProto.EXTERNAL,
                    f"{file.name}: external tensor data")

    walk(model)
    # Validate the graph without rewriting or re-exporting its bytes.
    onnx.checker.check_model(model)
    return counts


def audit_npz(file, terms):
    expected = {f"descriptor_embedding_{i}.npy" for i in range(5)}
    with zipfile.ZipFile(file) as archive:
        require(set(archive.namelist()) == expected and len(archive.infolist()) == len(expected),
                f"{file.name}: unexpected or duplicate archive members")
        require(not archive.comment, f"{file.name}: archive comment")
        for entry in archive.infolist():
            require(not entry.comment and not entry.extra, f"{file.name}: archive metadata")
            require(entry.date_time == (1980, 1, 1, 0, 0, 0), f"{file.name}: non-neutral archive timestamp")
            require(entry.file_size < 1024 * 1024, f"{file.name}: oversized member")
            data = archive.read(entry)
            audit_identity_bytes(data, file.name, terms)
            require(data[:8] == b"\x93NUMPY\x01\x00", f"{file.name}: unexpected NPY format")
            size = struct.unpack_from("<H", data, 8)[0]
            header = data[10:10 + size].decode("ascii")
            audit_text(header, file.name, terms)
            fields = ast.literal_eval(header)
            require(fields == {"descr": "<f4", "fortran_order": False, "shape": (8, 512)},
                    f"{file.name}: unexpected array header")
            require(len(data) == 10 + size + 8 * 512 * 4, f"{file.name}: unexpected array payload")
    return {"numericArrays": len(expected)}


def catalog_files():
    catalog = json.loads((ROOT / "engine/catalog.json").read_text())
    component = next(c for c in catalog["components"] if c["id"] == "fretformer-v1-onnx")
    files = component["files"]
    seen = set()
    for entry in files:
        relative = PurePosixPath(entry["path"])
        require(not relative.is_absolute() and ".." not in relative.parts
                and "\\" not in entry["path"] and str(relative) == entry["path"], "Unsafe catalog path")
        require(entry["path"] not in seen, "Duplicate catalog path")
        seen.add(entry["path"])
        require(entry["source"] in {"remote", "bundled-license"}, "Unexpected catalog source")
        require(relative.parts[0] == ("fretformer-v1" if entry["source"] == "remote" else "licenses"),
                "Unexpected catalog directory")
    pack = next(p for p in catalog["packs"] if p["id"] == "standard-onnx")
    remote = [f for f in files if f["source"] == "remote"]
    require(pack["downloadBytes"] == sum(f["size"] for f in remote)
            and pack["downloadFileCount"] == len(remote), "Catalog totals mismatch")
    return files


def checksum_text(records):
    return "".join(f"{records[name]['sha256']}  {name}\n" for name in sorted(records))


def audit_folder(folder, files, terms):
    require(folder.is_dir() and not folder.is_symlink(), "Payload must be a real directory")
    expected = {f["path"] for f in files} | {"README.md", ".gitattributes", "SHA256SUMS.txt"}
    directories = {str(parent) for name in expected for parent in PurePosixPath(name).parents
                   if str(parent) != "."}
    actual = set()
    for file in folder.rglob("*"):
        name = file.relative_to(folder).as_posix()
        require(not file.is_symlink(), "Payload contains a symlink")
        if file.is_dir():
            require(name in directories, "Payload contains an unexpected directory")
        else:
            require(file.is_file(), "Payload contains a special file")
            actual.add(name)
    require(actual == expected, "Payload file allowlist mismatch")
    pins = {f["path"]: f for f in files}
    records = {}
    for name in sorted(expected):
        file = folder / name
        data = file.read_bytes()
        audit_text(name, "filename", terms)
        audit_identity_bytes(data, name, terms)
        record = {"size": len(data), "sha256": digest(data)}
        if name in pins:
            require(record == {k: pins[name][k] for k in ("size", "sha256")}, f"{name}: catalog mismatch")
        if file.suffix == ".onnx":
            record.update(audit_onnx(file, terms))
        elif file.suffix == ".npz":
            record.update(audit_npz(file, terms))
        else:
            audit_text(data.decode("utf-8", errors="strict"), name, terms)
        if name != "SHA256SUMS.txt":
            records[name] = record
    require((folder / "SHA256SUMS.txt").read_text() == checksum_text(records), "Checksum list mismatch")
    return {"status": "passed", "fileCount": len(expected), "files": records,
            "checks": ["exact-file-allowlist", "no-symlinks", "catalog-pins", "identity-bytes-utf8-utf16",
                       "onnx-all-text-fields", "onnx-structure", "npz-members-and-headers",
                       "local-paths", "email-addresses", "ipv4-ipv6", "credentials", "reviewed-urls"],
            "scope": "Payload files and serialized metadata; excludes hosting account and commit identity."}


def prepare(output, files, terms):
    require(not output.exists() and not output.is_symlink(), "Output exists; use --verify-only or a new --output")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".model-pack-", dir=output.parent))
    try:
        for entry in files:
            source = ROOT / ("engine/models-onnx" if entry["source"] == "remote" else "engine") / entry["path"]
            data = source.read_bytes()  # Materialize development symlinks, never copy them.
            require(len(data) == entry["size"] and digest(data) == entry["sha256"],
                    f"{entry['path']}: source catalog mismatch")
            destination = staging / entry["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        (staging / "README.md").write_bytes((ROOT / "docs/huggingface-model-card.md").read_bytes())
        (staging / ".gitattributes").write_text(ATTRIBUTES)
        records = {p.relative_to(staging).as_posix(): {"sha256": digest(p.read_bytes())}
                   for p in staging.rglob("*") if p.is_file()}
        (staging / "SHA256SUMS.txt").write_text(checksum_text(records))
        report = audit_folder(staging, files, terms)
        for p in staging.rglob("*"):
            p.chmod(0o755 if p.is_dir() else 0o644)
            os.utime(p, (315532800, 315532800))
        staging.chmod(0o755)
        staging.rename(output)
        return report
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    files = catalog_files()
    terms = deny_terms()
    require(bool(os.environ.get("AUTOCHART_PUBLIC_DENY", "").strip()),
            "Set AUTOCHART_PUBLIC_DENY to a comma-separated list of private names/handles")
    report = audit_folder(args.output, files, terms) if args.verify_only else prepare(args.output, files, terms)
    # Keep the local audit report outside the upload directory; never include source paths or deny values.
    (args.output.parent / f"{args.output.name}-privacy-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"PASS: {report['fileCount']} upload files; catalog integrity and privacy audit passed.")


if __name__ == "__main__":
    main()
