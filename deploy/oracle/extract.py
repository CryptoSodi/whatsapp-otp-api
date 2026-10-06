"""Validate and extract a CI release without trusting archive paths or links."""
import pathlib
import sys
import tarfile

archive, destination, revision = sys.argv[1:]
allowed = {"dist", "node_modules", "package.json", "package-lock.json", "REVISION"}
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if len(members) > 30000 or sum(m.size for m in members) > 700 * 1024 * 1024:
        raise ValueError("Release exceeds extraction limits")
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] not in allowed:
            raise ValueError("Unexpected release path")
        if not (member.isfile() or member.isdir() or member.issym()):
            raise ValueError("Unexpected archive entry type")
    bundle.extractall(destination, members=members, filter="data")
root = pathlib.Path(destination)
if (root / "REVISION").read_text().strip() != revision:
    raise ValueError("Release revision mismatch")
for name in ("dist/server.js", "package.json", "node_modules/fastify/package.json"):
    if not (root / name).is_file():
        raise ValueError("Release is incomplete")
