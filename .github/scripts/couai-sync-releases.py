"""Mirror published upstream releases, exact tag objects, and release assets."""

import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def api(path, method="GET", data=None):
    request = Request(
        "https://api.github.com/" + path,
        method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urlopen(request, timeout=90) as response:
        body = response.read()
        return json.loads(body) if body else None


def optional(path):
    try:
        return api(path)
    except HTTPError as error:
        if error.code != 404:
            raise
        return None


def pages(path):
    page = 1
    while True:
        items = api(f"{path}?per_page=100&page={page}")
        yield from items
        if len(items) < 100:
            return
        page += 1


def download(asset, path):
    digest = hashlib.sha256()
    # Public upstream downloads need no token; do not forward credentials.
    with urlopen(asset["browser_download_url"], timeout=180) as response, path.open("wb") as file:
        while chunk := response.read(1024 * 1024):
            file.write(chunk)
            digest.update(chunk)
    actual = "sha256:" + digest.hexdigest()
    if path.stat().st_size != asset["size"]:
        raise RuntimeError(f"Incomplete download: {asset['name']}")
    if asset.get("digest") and asset["digest"] != actual:
        raise RuntimeError(f"Checksum mismatch: {asset['name']}")
    return actual


def upload(repository, release_id, asset, path):
    query = urlencode({"name": asset["name"], "label": asset.get("label") or ""})
    with path.open("rb") as file:
        request = Request(
            f"https://uploads.github.com/repos/{repository}/releases/{release_id}/assets?{query}",
            method="POST",
            data=file,
            headers={
                "Authorization": "Bearer " + os.environ["GH_TOKEN"],
                "Accept": "application/vnd.github+json",
                "Content-Type": asset.get("content_type") or "application/octet-stream",
                "Content-Length": str(path.stat().st_size),
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urlopen(request, timeout=300) as response:
            return json.load(response)


def sync():
    source = os.environ["UPSTREAM_REPOSITORY"]
    target = os.environ["GITHUB_REPOSITORY"]
    dry_run = os.environ.get("DRY_RUN", "false").lower() == "true"
    releases = [r for r in pages(f"repos/{source}/releases") if not r["draft"]]
    existing = {r["tag_name"]: r for r in pages(f"repos/{target}/releases")}
    latest = (optional(f"repos/{source}/releases/latest") or {}).get("tag_name")
    target_latest = (optional(f"repos/{target}/releases/latest") or {}).get("tag_name")
    totals = {"releases_checked": 0, "releases_created": 0, "releases_updated": 0,
              "tags_checked": 0, "assets_uploaded": 0, "asset_labels_updated": 0}

    # Oldest first, preserving the upstream's explicitly selected latest release.
    for release in sorted(releases, key=lambda r: r["published_at"]):
        tag = release["tag_name"]
        totals["releases_checked"] += 1
        tag_path = "git/ref/tags/" + quote(tag, safe="")
        source_ref = api(f"repos/{source}/{tag_path}")
        target_ref = optional(f"repos/{target}/{tag_path}")
        totals["tags_checked"] += 1
        if target_ref and target_ref["object"]["sha"] != source_ref["object"]["sha"]:
            raise RuntimeError(f"Tag {tag} differs from upstream; retained the existing target tag")
        if not target_ref and not dry_run:
            raise RuntimeError(f"Missing tag {tag}; the code/tag sync job must run first")

        metadata = {"tag_name": tag, "name": release.get("name") or "",
                    "body": release.get("body") or "", "prerelease": release["prerelease"]}
        destination = existing.get(tag)
        created = destination is None
        if created:
            totals["releases_created"] += 1
            if not dry_run:
                # Publish only after every asset has been uploaded and verified.
                destination = api(f"repos/{target}/releases", "POST", {**metadata, "draft": True})

        source_assets = list(pages(f"repos/{source}/releases/{release['id']}/assets"))
        target_assets = {} if not destination else {
            a["name"]: a for a in pages(f"repos/{target}/releases/{destination['id']}/assets")
        }
        for asset in source_assets:
            previous = target_assets.get(asset["name"])
            same_bytes = (previous and previous["state"] == "uploaded"
                          and previous["size"] == asset["size"] and asset.get("digest")
                          and previous.get("digest") == asset["digest"])
            if same_bytes:
                if (previous.get("label") or "") != (asset.get("label") or ""):
                    if not dry_run:
                        api(f"repos/{target}/releases/assets/{previous['id']}", "PATCH",
                            {"label": asset.get("label") or ""})
                    totals["asset_labels_updated"] += 1
                continue
            print(f"{'Would copy' if dry_run else 'Copying'} {tag}/{asset['name']} ({asset['size']} bytes)", flush=True)
            if not dry_run:
                with tempfile.TemporaryDirectory(prefix="release-sync-") as directory:
                    path = Path(directory) / "asset"
                    digest = download(asset, path)
                    # Older upstream assets may have no digest; compare after hashing.
                    if previous and previous.get("digest") == digest:
                        continue
                    if previous:
                        api(f"repos/{target}/releases/assets/{previous['id']}", "DELETE")
                    uploaded = upload(target, destination["id"], asset, path)
                    if uploaded["size"] != asset["size"] or uploaded.get("digest") != digest:
                        raise RuntimeError(f"Uploaded asset verification failed: {tag}/{asset['name']}")
            totals["assets_uploaded"] += 1

        changed = (not destination or destination["draft"]
                   or any((destination.get(k) or "") != (v or "") for k, v in metadata.items())
                   or (tag == latest and tag != target_latest))
        if changed:
            if not dry_run:
                api(f"repos/{target}/releases/{destination['id']}", "PATCH", {
                    **metadata, "draft": False, "make_latest": "true" if tag == latest else "false",
                })
            if not created:
                totals["releases_updated"] += 1
        print(f"{'Checked' if dry_run else 'Synced'} {tag}: {len(source_assets)} assets", flush=True)

    report = {"source": source, "target": target, "dry_run": dry_run, **totals}
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered, flush=True)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(summary).open("a") as file:
            file.write("## Release sync\n\n```json\n" + rendered + "\n```\n")


if __name__ == "__main__":
    sync()
