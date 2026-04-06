(() => {
  const cfg = window.MC_STATUS_CONFIG || {};
  const statusUrl = cfg.statusUrl || "http://localhost:8080/status";
  const pollIntervalMs = Number(cfg.pollIntervalMs || 5000);
  const requestTimeoutMs = Number(cfg.requestTimeoutMs || 4000);

  const el = {
    onlineBadge: document.getElementById("onlineBadge"),
    serverName: document.getElementById("serverName"),
    players: document.getElementById("players"),
    tps: document.getElementById("tps"),
    version: document.getElementById("version"),
    lastChecked: document.getElementById("lastChecked"),
    statusUrl: document.getElementById("statusUrl"),
    message: document.getElementById("message")
  };

  function updateLastChecked() {
    const now = new Date();
    el.lastChecked.textContent = now.toLocaleString();
  }

  function setOnline(data) {
    el.onlineBadge.textContent = "オンライン";
    el.onlineBadge.classList.remove("offline");
    el.onlineBadge.classList.add("online");

    el.serverName.textContent = data.serverName ?? "-";
    el.players.textContent = `${data.players ?? "-"} / ${data.maxPlayers ?? "-"}`;
    el.tps.textContent = data.tps ?? "-";
    el.version.textContent = data.version ?? "-";

    el.message.textContent = "正常に取得できました。";
  }

  function setOffline(reason) {
    el.onlineBadge.textContent = "オフライン";
    el.onlineBadge.classList.remove("online");
    el.onlineBadge.classList.add("offline");

    el.serverName.textContent = "-";
    el.players.textContent = "- / -";
    el.tps.textContent = "-";
    el.version.textContent = "-";

    el.message.textContent = `取得失敗: ${reason}`;
  }

  async function fetchStatus() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const res = await fetch(statusUrl, {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      setOnline(data);
    } catch (err) {
      const reason = err && err.name === "AbortError"
        ? `タイムアウト (${requestTimeoutMs}ms)`
        : (err && err.message ? err.message : "不明なエラー");
      setOffline(reason);
    } finally {
      clearTimeout(timeout);
      updateLastChecked();
    }
  }

  function startPolling() {
    el.statusUrl.textContent = statusUrl;
    fetchStatus();
    setInterval(fetchStatus, pollIntervalMs);
  }

  startPolling();
})();
