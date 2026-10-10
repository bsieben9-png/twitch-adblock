import source from "../src/general-exclude-hosts.js" with { type: "text" };
import manifest from "../manifest.json" with { type: "json" };

function assert(condition, label) {
  if (!condition) throw new Error(label);
}

function assertEquals(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${label || "expected equal values"}\n${left}\n${right}`);
  }
}

const api = {};
const installGeneralExcludeHosts = new Function(
  `${source}\nreturn installGeneralExcludeHosts;`,
)();
installGeneralExcludeHosts(api);

Deno.test("Twitch, YouTube family, and Kick site hosts are excluded", () => {
  const sites = [
    "twitch.tv",
    "www.twitch.tv",
    "clips.twitch.tv",
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "studio.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "youtubekids.com",
    "www.youtubekids.com",
    "kick.com",
    "www.kick.com",
  ];
  for (const host of sites) {
    assert(api.isExcludedSiteHost(host), `site excluded: ${host}`);
    assert(api.isExcludedHost(host), `host excluded: ${host}`);
  }
});

Deno.test("stream video CDN hosts are excluded", () => {
  const cdns = [
    "usher.ttvnw.net",
    "video-weaver.ttvnw.net",
    "static.twitchcdn.net",
    "rr3---sn-abc.googlevideo.com",
    "i.ytimg.com",
    "yt3.ggpht.com",
    "abc.global-contribute.live-video.net",
    "playback.live-video.net",
  ];
  for (const host of cdns) {
    assert(api.isExcludedHost(host), `cdn excluded: ${host}`);
  }
});

Deno.test("ordinary sites are not excluded", () => {
  for (const host of ["example.com", "news.ycombinator.com", "wikipedia.org"]) {
    assert(!api.isExcludedHost(host), `not excluded: ${host}`);
    assert(!api.isExcludedSiteHost(host), `not site-excluded: ${host}`);
  }
});

Deno.test("DNR exclusion rules stay lean (two rules, high priority)", () => {
  const rules = api.buildDnrExclusionRules({ idStart: 10, priority: 2_000_000 });
  assertEquals(rules.length, 2, "exactly two exclusion rules");
  assertEquals(rules[0].id, 10);
  assertEquals(rules[1].id, 11);
  assertEquals(rules[0].action.type, "allowAllRequests");
  assertEquals(rules[1].action.type, "allow");
  assertEquals(rules[0].priority, 2_000_000);
  assert(rules[0].condition.requestDomains.includes("twitch.tv"));
  assert(rules[0].condition.requestDomains.includes("youtube.com"));
  assert(rules[0].condition.requestDomains.includes("kick.com"));
  assert(rules[0].condition.requestDomains.includes("youtubekids.com"));
  assert(rules[1].condition.requestDomains.includes("ttvnw.net"));
  assert(rules[1].condition.requestDomains.includes("googlevideo.com"));
  assert(rules[1].condition.requestDomains.includes("live-video.net"));
  assert(
    !rules[1].condition.requestDomains.includes("googleapis.com"),
    "do not blanket-allow googleapis.com",
  );
});

Deno.test("exclusion module source has no https URLs or playback chrome APIs", () => {
  assert(!/https?:\/\//i.test(source), "no http(s) URLs in exclude module");
  assert(!/\bchrome\./.test(source), "no chrome.* in exclude module");
  assert(
    !/doubleclick|googlesyndication|google-analytics/i.test(source),
    "no tracker phone-home strings",
  );
});

Deno.test("playback scripts stay outside this change set (manifest still stream-only)", () => {
  const permissions = manifest.permissions || [];
  assertEquals(permissions, [], "no DNR permission wired yet in this slice");
  const scripts = (manifest.content_scripts || []).flatMap((s) => s.js || []);
  assert(!scripts.includes("src/general-exclude-hosts.js"), "not injected as content script");
});
