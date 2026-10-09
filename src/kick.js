// Runs on Kick at document_start. In-player ads are skipped only when the
// IVS player can jump back to the stream. If a skip would rewind a long way,
// or the player cannot take it, the ad plays. The video element is never
// hidden, muted, or sped up.
function installKickAdblock(target) {
  const AD_BREAK_STARTED = "PlayerAdBreakStarted";
  const AD_BREAK_ENDED = "PlayerAdBreakEnded";
  const TIME_UPDATE = "PlayerTimeUpdate";
  const SKIP_LIMIT = 2;
  const SKIP_WINDOW_MS = 60000;
  const HOLD_MS = 8000;
  const AD_CHROME_SELECTORS = [
    '[data-testid="ad-click-overlay"]',
    '[data-testid="ad-learn-more"]',
    '[data-testid="ad-learn-more-mobile"]',
    '[data-testid="ad-fullscreen"]',
    '[data-testid="ad-skip-countdown"]',
    '[aria-label="Ad progress"]',
    '[aria-label="Visit advertiser"]',
  ];

  function onKickHost(host) {
    const value = String(host || "").toLowerCase();
    return value === "kick.com" || value.endsWith(".kick.com");
  }

  function isIvsWorkerUrl(url) {
    return String(url || "").includes("amazon-ivs-wasmworker");
  }

  function emptyState() {
    return { attempts: [], position: null, playerId: null, holdUntil: 0, holdAction: "" };
  }

  function copyState(state) {
    const source = state || emptyState();
    return {
      attempts: Array.isArray(source.attempts) ? source.attempts.slice() : [],
      position: source.position,
      playerId: source.playerId,
      holdUntil: source.holdUntil || 0,
      holdAction: source.holdAction || "",
    };
  }

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function readSkipTarget(detail) {
    if (!detail || typeof detail !== "object") return null;
    const adObject = detail.adObject;
    const metadata = detail.metadata;
    const candidates = [
      adObject && adObject.targetPlayheadForAdSkip,
      metadata && metadata.targetPlayheadForAdSkip,
      detail.targetPlayheadForAdSkip,
    ];
    for (const candidate of candidates) {
      const number = finiteNumber(candidate);
      if (number != null && number >= 0) return number;
    }
    return null;
  }

  // A short step backward is how a skip leaves an ad. A jump back to the
  // start of a long live timeline is not.
  function seekWouldRewind(position, targetTime) {
    const place = finiteNumber(position);
    const targetSeconds = finiteNumber(targetTime);
    if (place == null || targetSeconds == null) return false;
    const back = place - targetSeconds;
    if (back <= 15) return false;
    if (targetSeconds < 5 && place > 30) return true;
    return back > 120;
  }

  function freshAttempts(attempts, now) {
    const kept = [];
    const list = Array.isArray(attempts) ? attempts : [];
    for (const stamp of list) {
      if (typeof stamp === "number" && now - stamp < SKIP_WINDOW_MS) kept.push(stamp);
    }
    return kept;
  }

  function chooseSkip(input) {
    const now = input.now;
    const attempts = freshAttempts(input.attempts, now);
    if (attempts.length >= SKIP_LIMIT) return { action: "play", attempts };
    const targetTime = readSkipTarget(input.detail);
    if (targetTime != null && !seekWouldRewind(input.position, targetTime)) {
      attempts.push(now);
      return { action: "seek", target: targetTime, attempts };
    }
    if (input.allowSkipAd && input.hasSkipAd) {
      attempts.push(now);
      return { action: "skipAd", attempts };
    }
    return { action: "play", attempts };
  }

  // A seek is the precise skip. It may follow one player skipAd. A second
  // seek, or a skipAd after a seek, waits so the break cannot loop.
  function suppress(state, now, action) {
    if (!(state.holdUntil > now)) return false;
    if (state.holdAction === "seek") return true;
    return action !== "seek";
  }

  function reduceIvsMessage(state, data, now) {
    const next = copyState(state);
    if (!data || typeof data !== "object") return { state: next, command: null };
    if (data.id != null) next.playerId = data.id;
    if (data.type === TIME_UPDATE) {
      const place = finiteNumber(data.arg);
      if (place != null) next.position = place;
      return { state: next, command: null };
    }
    if (data.type === AD_BREAK_ENDED) {
      next.holdUntil = 0;
      next.holdAction = "";
      return { state: next, command: null };
    }
    if (data.type !== AD_BREAK_STARTED || data.id == null) {
      return { state: next, command: null };
    }
    const choice = chooseSkip({
      detail: data.arg,
      position: next.position,
      hasSkipAd: true,
      allowSkipAd: true,
      now,
      attempts: next.attempts,
    });
    if (choice.action === "play" || suppress(next, now, choice.action)) {
      return { state: next, command: null };
    }
    next.attempts = choice.attempts;
    next.holdUntil = now + HOLD_MS;
    next.holdAction = choice.action;
    if (choice.action === "seek") {
      return { state: next, command: { id: data.id, funcName: "seekTo", args: [choice.target] } };
    }
    return { state: next, command: { id: data.id, funcName: "skipAd", args: undefined } };
  }

  function reduceSessionDetail(state, detail, now) {
    const next = copyState(state);
    if (next.playerId == null) return { state: next, command: null };
    const choice = chooseSkip({
      detail,
      position: next.position,
      hasSkipAd: false,
      allowSkipAd: false,
      now,
      attempts: next.attempts,
    });
    if (choice.action !== "seek" || suppress(next, now, choice.action)) {
      return { state: next, command: null };
    }
    next.attempts = choice.attempts;
    next.holdUntil = now + HOLD_MS;
    next.holdAction = "seek";
    return { state: next, command: { id: next.playerId, funcName: "seekTo", args: [choice.target] } };
  }

  function chromeCss() {
    return `${AD_CHROME_SELECTORS.join(",")}{display:none!important;pointer-events:none!important;}`;
  }

  target.onKickHost = onKickHost;
  target.isIvsWorkerUrl = isIvsWorkerUrl;
  target.emptyState = emptyState;
  target.readSkipTarget = readSkipTarget;
  target.seekWouldRewind = seekWouldRewind;
  target.chooseSkip = chooseSkip;
  target.reduceIvsMessage = reduceIvsMessage;
  target.reduceSessionDetail = reduceSessionDetail;
  target.chromeCss = chromeCss;
  target.AD_CHROME_SELECTORS = AD_CHROME_SELECTORS;
  target.AD_BREAK_STARTED = AD_BREAK_STARTED;
  target.SKIP_LIMIT = SKIP_LIMIT;
  target.SKIP_WINDOW_MS = SKIP_WINDOW_MS;
  target.HOLD_MS = HOLD_MS;

  function injectChromeCss() {
    try {
      if (typeof document === "undefined" || !document.createElement) return;
      if (document.getElementById && document.getElementById("twitch-adblock-kick-css")) return;
      const style = document.createElement("style");
      style.id = "twitch-adblock-kick-css";
      style.textContent = chromeCss();
      const parent = document.head || document.documentElement;
      if (!parent || typeof parent.appendChild !== "function") return;
      parent.appendChild(style);
    } catch (error) {
      console.log("twitch-adblock kick failed open", error);
    }
  }

  function postCommand(worker, command) {
    if (!worker || !command) return;
    try {
      worker.postMessage({ id: command.id, funcName: command.funcName, args: command.args });
    } catch (error) {
      console.log("twitch-adblock kick failed open", error);
    }
  }

  function watchIvsWorker(worker, bridge) {
    worker.addEventListener("message", (event) => {
      try {
        postCommand(worker, bridge.onIvsMessage(event && event.data));
      } catch (error) {
        console.log("twitch-adblock kick failed open", error);
      }
    });
  }

  function installWorkerHook(root, onIvsWorker) {
    const NativeWorker = root.Worker;
    if (typeof NativeWorker !== "function" || NativeWorker.__kickAdblock) return;
    function WrappedWorker(url, options) {
      const worker = arguments.length > 1 ? new NativeWorker(url, options) : new NativeWorker(url);
      try {
        if (isIvsWorkerUrl(url)) onIvsWorker(worker);
      } catch (error) {
        console.log("twitch-adblock kick failed open", error);
      }
      return worker;
    }
    WrappedWorker.prototype = NativeWorker.prototype;
    WrappedWorker.__kickAdblock = true;
    root.Worker = WrappedWorker;
  }

  function wrapMediaTailor(media, onDetail) {
    if (!media || media.__kickAdblock || typeof media.createSession !== "function") return media;
    const nativeCreate = media.createSession.bind(media);
    media.createSession = function (options) {
      return Promise.resolve(nativeCreate(options)).then((session) => {
        if (!session || session.__kickAdblock || typeof session.addEventListener !== "function") return session;
        const nativeAdd = session.addEventListener.bind(session);
        session.addEventListener = function (type, listener, listenerOptions) {
          return nativeAdd(type, function (event) {
            try {
              const detail = event && typeof event === "object" ? event.detail : null;
              onDetail(detail);
            } catch (error) {
              console.log("twitch-adblock kick failed open", error);
            }
            if (typeof listener === "function") return listener.call(this, event);
            if (listener && typeof listener.handleEvent === "function") return listener.handleEvent(event);
          }, listenerOptions);
        };
        session.__kickAdblock = true;
        return session;
      });
    };
    media.__kickAdblock = true;
    return media;
  }

  function installDatazoomHook(root, onDetail) {
    let sdk = root.datazoom;
    function wrapSdk(value) {
      if (!value || value.__kickAdblockSdk) return value;
      let media = value.mediatailor;
      try {
        Object.defineProperty(value, "mediatailor", {
          configurable: true,
          enumerable: true,
          get() {
            media = wrapMediaTailor(media, onDetail);
            return media;
          },
          set(next) {
            media = next;
          },
        });
      } catch (error) {
        console.log("twitch-adblock kick failed open", error);
        wrapMediaTailor(media, onDetail);
      }
      value.__kickAdblockSdk = true;
      return value;
    }
    try {
      Object.defineProperty(root, "datazoom", {
        configurable: true,
        enumerable: true,
        get() {
          return sdk;
        },
        set(value) {
          sdk = wrapSdk(value);
        },
      });
    } catch (error) {
      console.log("twitch-adblock kick failed open", error);
      if (sdk) wrapSdk(sdk);
      return;
    }
    if (sdk) sdk = wrapSdk(sdk);
  }

  function startKickAdblock() {
    let host = "";
    try {
      host = location.hostname;
    } catch {
      return;
    }
    if (!onKickHost(host) || typeof window === "undefined") return;
    const bridge = {
      state: emptyState(),
      onIvsMessage(data) {
        const result = reduceIvsMessage(this.state, data, Date.now());
        this.state = result.state;
        return result.command;
      },
      onSessionDetail(detail) {
        const result = reduceSessionDetail(this.state, detail, Date.now());
        this.state = result.state;
        return result.command;
      },
    };
    let ivsWorker = null;
    installWorkerHook(window, (worker) => {
      ivsWorker = worker;
      watchIvsWorker(worker, bridge);
    });
    installDatazoomHook(window, (detail) => {
      postCommand(ivsWorker, bridge.onSessionDetail(detail));
    });
    injectChromeCss();
    console.log("twitch-adblock: watching Kick");
  }

  target.startKickAdblock = startKickAdblock;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const api = {};
  installKickAdblock(api);
  api.startKickAdblock();
}
