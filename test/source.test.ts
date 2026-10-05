import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedSourcePath, isOfficialRepo, parseRemoteRefs, parseRepo } from "../src/source.ts";

test("parseRepo accepts GitHub owner/repo and https URLs to any host", () => {
  assert.deepEqual(parseRepo("someone/rotorflight-firmware"),
    { url: "https://github.com/someone/rotorflight-firmware.git", name: "someone/rotorflight-firmware" });
  assert.deepEqual(parseRepo(" https://github.com/Some-One/rf-fork.git/ "),
    { url: "https://github.com/Some-One/rf-fork.git", name: "Some-One/rf-fork" });
  assert.deepEqual(parseRepo("https://gitlab.com/group/sub/rf"),
    { url: "https://gitlab.com/group/sub/rf.git", name: "gitlab.com/group/sub/rf" });
});

test("parseRepo refuses anything but plain public https", () => {
  for (const bad of ["", "not a repo", "git@github.com:a/b.git", "ssh://github.com/a/b", "file:///C:/x",
    "http://github.com/a/b", "https://user:pw@github.com/a/b", "https://github.com/", "C:\\Projects\\x"]) {
    assert.throws(() => parseRepo(bad), /not a|not a supported/, bad);
  }
});

test("the official repository is recognised however it is written", () => {
  assert.ok(isOfficialRepo(parseRepo("rotorflight/rotorflight-firmware").url));
  assert.ok(isOfficialRepo("https://github.com/rotorflight/rotorflight-firmware"));
  assert.ok(!isOfficialRepo(parseRepo("someone/rotorflight-firmware").url));
});

test("forks are cached apart from the official refs, in short folders", () => {
  const official = cachedSourcePath("release/4.6.0");
  assert.match(official, /release-4\.6\.0$/);
  assert.equal(cachedSourcePath("release/4.6.0", "https://github.com/rotorflight/rotorflight-firmware.git"), official);
  const fork = cachedSourcePath("release/4.6.0", "https://github.com/someone/rotorflight-firmware.git");
  const other = cachedSourcePath("master", "https://github.com/someone/rotorflight-firmware.git");
  assert.notEqual(fork, official);
  assert.notEqual(fork, other);
  assert.match(fork, /[\\/]forks[\\/]f-[0-9a-f]{10}$/); // short: Windows path limit
});

test("parseRemoteRefs reads git ls-remote --symref output", () => {
  const out = [
    "ref: refs/heads/master\tHEAD",
    "1111111111111111111111111111111111111111\tHEAD",
    "2222222222222222222222222222222222222222\trefs/heads/feature/gps-guard",
    "1111111111111111111111111111111111111111\trefs/heads/master",
    "6666666666666666666666666666666666666666\trefs/tags/testing/FF20230821D",
    "3333333333333333333333333333333333333333\trefs/tags/release/4.5.0",
    "4444444444444444444444444444444444444444\trefs/tags/release/4.10.0",
    "5555555555555555555555555555555555555555\trefs/tags/release/4.10.0^{}",
  ].join("\r\n");
  assert.deepEqual(parseRemoteRefs(out), {
    defaultBranch: "master",
    branches: ["master", "feature/gps-guard"],
    // Releases first, newest first; peeled duplicates dropped.
    tags: ["release/4.10.0", "release/4.5.0", "testing/FF20230821D"],
  });
});
