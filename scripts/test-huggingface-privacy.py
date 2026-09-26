#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["onnx==1.22.0"]
# ///
"""Privacy leak and payload integrity regression probes (synthetic data only)."""

import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import onnx

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("pack", Path(__file__).with_name("prepare-huggingface.py"))
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)


class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hf-privacy-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.terms = ["private-person", "private-handle"]

    def test_identifiers_network_paths_credentials(self):
        leaks = [
            "PRIVATE-PERSON", "private-handle", "/home/someone/export.py",
            "/Users/someone/export.py", "/mnt/storage/model.pt", "C:\\Users\\someone\\model.pt",
            "C:/work/export.py", "\\\\workstation\\share", "person@example.org",
            "https://unreviewed.example.org/model", "http://192.0.2.12/models",
            "https://github.com/facebookresearch/demucs-private",
            "2001:db8::1", "::1", "[fe80::1234%eth0]", "server.lan", "localhost",
            "hf_" + "a" * 32,
        ]
        for text in leaks:
            with self.subTest(text=text), self.assertRaises(ValueError):
                pack.audit_text(text, "fixture", self.terms)
        for text in ["onnx::Cast_31", "pytorch 2.8.0", "CC BY-NC-SA 4.0",
                     "https://github.com/facebookresearch/demucs", "model/layers.0.weight"]:
            pack.audit_text(text, "fixture", self.terms)
        for encoding in ("utf-8", "utf-16-le", "utf-16-be"):
            with self.subTest(encoding=encoding), self.assertRaises(ValueError):
                pack.audit_identity_bytes("PRIVATE-HANDLE".encode(encoding), "fixture", self.terms)

    def make_model(self):
        info = onnx.helper.make_tensor_value_info
        graph = onnx.helper.make_graph(
            [onnx.helper.make_node("Identity", ["x"], ["y"])], "public-model",
            [info("x", onnx.TensorProto.FLOAT, [1])], [info("y", onnx.TensorProto.FLOAT, [1])],
        )
        return onnx.helper.make_model(graph)

    def test_nested_onnx_metadata_and_string_attributes(self):
        file = self.root / "model.onnx"
        model = self.make_model()
        onnx.save(model, file)
        self.assertGreater(pack.audit_onnx(file, self.terms)["textFields"], 0)
        mutations = [
            lambda m: setattr(m.graph.node[0], "doc_string", "/home/someone/export.py"),
            lambda m: m.metadata_props.add(key="author", value="private-person"),
            lambda m: m.graph.node[0].attribute.append(onnx.helper.make_attribute("note", b"private-handle")),
            lambda m: m.graph.initializer.append(onnx.helper.make_tensor("label", onnx.TensorProto.STRING, [1], ["private-person"])),
        ]
        for mutate in mutations:
            model = self.make_model()
            mutate(model)
            onnx.save(model, file)
            with self.assertRaisesRegex(ValueError, "local path|blocked identity"):
                pack.audit_onnx(file, self.terms)

    def test_external_tensor_reference_is_rejected(self):
        model = self.make_model()
        tensor = model.graph.initializer.add(name="external", data_type=onnx.TensorProto.FLOAT, dims=[1])
        tensor.data_location = onnx.TensorProto.EXTERNAL
        tensor.external_data.add(key="location", value="weights.bin")
        file = self.root / "model.onnx"
        file.write_bytes(model.SerializeToString())
        with self.assertRaisesRegex(ValueError, "external tensor data"):
            pack.audit_onnx(file, self.terms)

    def make_npz(self, *, comment=b"", leak=False):
        file = self.root / "prefix_tables.npz"
        header = b"{'descr': '<f4', 'fortran_order': False, 'shape': (8, 512)}\n"
        payload = bytearray(8 * 512 * 4)
        if leak:
            payload[:14] = b"private-handle"
        data = b"\x93NUMPY\x01\x00" + struct.pack("<H", len(header)) + header + payload
        with zipfile.ZipFile(file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.comment = comment
            for i in range(5):
                archive.writestr(zipfile.ZipInfo(f"descriptor_embedding_{i}.npy"), data,
                                 compress_type=zipfile.ZIP_DEFLATED)
        return file

    def test_npz_decompression_and_metadata(self):
        self.assertEqual(pack.audit_npz(self.make_npz(), self.terms), {"numericArrays": 5})
        with self.assertRaisesRegex(ValueError, "archive comment"):
            pack.audit_npz(self.make_npz(comment=b"private-person"), self.terms)
        with self.assertRaisesRegex(ValueError, "identity bytes"):
            pack.audit_npz(self.make_npz(leak=True), self.terms)

    def test_staging_allowlist_hashes_and_symlinks(self):
        source = self.root / "engine/models-onnx/fretformer-v1/manifest.json"
        source.parent.mkdir(parents=True)
        original = self.root / "original.json"
        original.write_bytes(b'{"public":true}\n')
        source.symlink_to(original)
        docs = self.root / "docs"
        docs.mkdir()
        card = docs / "huggingface-model-card.md"
        card.write_text("# Public model\n")
        files = [{"path": "fretformer-v1/manifest.json", "source": "remote",
                  "size": original.stat().st_size, "sha256": pack.digest(original.read_bytes())}]
        output = self.root / "upload"
        with patch.object(pack, "ROOT", self.root):
            pack.prepare(output, files, self.terms)
            self.assertFalse((output / files[0]["path"]).is_symlink())
            with self.assertRaisesRegex(ValueError, "Output exists"):
                pack.prepare(output, files, self.terms)
            extra = output / ".git"
            extra.mkdir()
            with self.assertRaisesRegex(ValueError, "unexpected directory"):
                pack.audit_folder(output, files, self.terms)
            extra.rmdir()
            leaked = output / "notes.txt"
            leaked.write_text("private-person")
            with self.assertRaisesRegex(ValueError, "allowlist"):
                pack.audit_folder(output, files, self.terms)
            leaked.unlink()
            staged = output / files[0]["path"]
            staged.unlink()
            staged.symlink_to(original)
            with self.assertRaisesRegex(ValueError, "symlink"):
                pack.audit_folder(output, files, self.terms)
            staged.unlink()
            staged.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "catalog mismatch"):
                pack.audit_folder(output, files, self.terms)
            card.write_text("private-handle")
            failed = self.root / "failed-upload"
            with self.assertRaisesRegex(ValueError, "identity"):
                pack.prepare(failed, files, self.terms)
            self.assertFalse(failed.exists())
            self.assertEqual(list(self.root.glob(".model-pack-*")), [])


if __name__ == "__main__":
    unittest.main()
