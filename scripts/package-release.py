"""Verify original v1.7.2 bytes and package the no-build extension."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "meet-vanish-extension"
EXPECTED = ROOT / "checksums" / "extension-v1.7.2.sha256"


def main():
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    if manifest["version"] != "1.7.2" or manifest["manifest_version"] != 3:
        raise SystemExit("Unexpected extension version or manifest type.")
    expected = {}
    for line in EXPECTED.read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        expected[name] = digest
    actual = {}
    for path in sorted(SOURCE.rglob("*")):
        if path.is_symlink():
            raise SystemExit(f"Refusing symlink: {path}")
        if path.is_file():
            name = path.relative_to(ROOT).as_posix()
            actual[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        changed = sorted(n for n in expected.keys() & actual.keys()
                         if expected[n] != actual[n])
        raise SystemExit(f"Original-file verification failed: "
                         f"missing={missing}, extra={extra}, changed={changed}")
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    archive = output / "Meet-Vanish-Chrome-Extension-v1.7.2.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(actual):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 5, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, (ROOT / name).read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = output / f"{archive.name}.sha256"
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    print(f"Verified {len(actual)} original extension files.")
    print(f"Created {archive.name} ({archive.stat().st_size:,} bytes)")
    print(f"SHA-256: {digest}")


if __name__ == "__main__":
    main()
