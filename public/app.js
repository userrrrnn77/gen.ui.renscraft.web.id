// public/app.js

// === STATE ===
let currentSessionId = null;
let currentMessages = [];
let activeBlocks = {};
let pendingAttachments = [];

// === INIT ===
document.addEventListener("DOMContentLoaded", () => {
  checkAuth();
  setupEventListeners();
});

function setupEventListeners() {
  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document
    .getElementById("new-chat-btn")
    .addEventListener("click", createSession);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);
  document.getElementById("send-btn").addEventListener("click", sendMessage);

  const input = document.getElementById("chat-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  });

  document
    .getElementById("file-upload")
    .addEventListener("change", handleFileUpload);
}

// --- HELPER SAFE MARKED ---
function safeMarkedParse(md) {
  try {
    return marked.parse(md || "");
  } catch (e) {
    return escapeHTML(md || "").replace(/\n/g, "<br>");
  }
}

// === AUTH ===
async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      document.getElementById("login-modal").classList.add("hidden");
      loadSessions();
    } else {
      document.getElementById("login-modal").classList.remove("hidden");
    }
  } catch {
    document.getElementById("login-modal").classList.remove("hidden");
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.classList.add("hidden");

  try {
    let res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok && res.status === 401) {
      // Coba register jika login gagal
      res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name: email.split("@")[0] }),
      });
    }

    if (res.ok) {
      document.getElementById("login-modal").classList.add("hidden");
      loadSessions();
    } else {
      const data = await res.json();
      errorEl.textContent = data.error?.message || "Login failed";
      errorEl.classList.remove("hidden");
    }
  } catch (err) {
    errorEl.textContent = "Network error";
    errorEl.classList.remove("hidden");
  }
}

async function handleLogout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.reload();
}

// === SESSIONS ===
async function loadSessions() {
  const res = await fetch("/api/sessions");
  if (!res.ok) return;
  const data = await res.json();
  const list = document.getElementById("session-list");
  list.innerHTML = "";

  data.items.forEach((s) => {
    const btn = document.createElement("button");
    btn.className = `w-full text-left px-3 py-2 rounded-lg text-sm truncate ${currentSessionId === s.id ? "bg-indigo-600/20 text-indigo-400 font-medium" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"}`;
    btn.textContent = s.title;
    btn.onclick = () => openSession(s.id, s.title);
    list.appendChild(btn);
  });
}

async function createSession() {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.ok) {
    const data = await res.json();
    loadSessions();
    openSession(data.id, data.title);
  }
}

async function openSession(id, title) {
  currentSessionId = id;
  document.getElementById("current-session-title").textContent = title;
  document.getElementById("empty-state").classList.add("hidden");
  document.getElementById("chat-container").innerHTML = "";
  activeBlocks = {};
  loadSessions();

  const res = await fetch(`/api/sessions/${id}`);
  if (!res.ok) return;
  const data = await res.json();

  data.messages.forEach((msg) => {
    if (msg.role === "user") {
      appendUserMessage(
        msg.blocks.find((b) => b.type === "text")?.markdown || "",
      );
    } else if (msg.role === "assistant") {
      msg.blocks.forEach((block, i) => {
        const blockEl = renderBlock(block, msg.id + "-" + i);
        document.getElementById("chat-container").appendChild(blockEl);
      });
    }
  });
  scrollToBottom();
}

// === CHAT & SSE ===
async function sendMessage() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text || !currentSessionId) return;

  input.value = "";
  input.style.height = "auto";

  appendUserMessage(text);
  pendingAttachments = [];
  renderAttachmentPreview();
  scrollToBottom();

  const assistantContainer = document.createElement("div");
  assistantContainer.className = "assistant-message space-y-4";
  document.getElementById("chat-container").appendChild(assistantContainer);

  try {
    const response = await fetch(`/api/sessions/${currentSessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) throw new Error("Failed to send");
    await handleSSEStream(response);
  } catch (err) {
    console.error(err);
    appendSystemMessage("Terjadi kesalahan koneksi.", true);
  }
}

async function handleSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const container = document.querySelector(".assistant-message:last-child");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop();

    for (const event of events) {
      if (!event.trim()) continue;
      const lines = event.split("\n");
      let eventType = "message";
      let dataStr = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
      }

      if (dataStr) {
        try {
          const data = JSON.parse(dataStr);
          handleSSEEvent(eventType, data, container);
        } catch (e) {
          console.warn("Parse error", e, dataStr);
        }
      }
    }
  }
}

function handleSSEEvent(type, data, container) {
  const key = `${data.index}`;

  switch (type) {
    case "message.start":
      break;

    case "block.start":
      activeBlocks[key] = data.block;
      const elStart = renderBlock(data.block, key, true);
      container.appendChild(elStart);
      scrollToBottom();
      break;

    case "block.delta":
      if (activeBlocks[key]) {
        if (activeBlocks[key].type === "text")
          activeBlocks[key].markdown += data.delta;
        if (activeBlocks[key].type === "code")
          activeBlocks[key].content += data.delta;
        updateBlockDOM(key, activeBlocks[key]);
      }
      scrollToBottom();
      break;

    case "block.end":
      activeBlocks[key] = data.block;
      updateBlockDOM(key, data.block);
      break;

    case "title":
      document.getElementById("current-session-title").textContent = data.title;
      loadSessions();
      break;

    case "error":
      appendSystemMessage(data.message, true);
      break;
  }
}

// === BLOCK RENDERER ===
function renderBlock(block, id, isStreaming = false) {
  const wrapper = document.createElement("div");
  wrapper.id = `block-${id}`;
  wrapper.className = "block-wrapper";

  if (block.type === "text") {
    wrapper.className += " prose prose-invert prose-zinc max-w-none";
    wrapper.innerHTML = safeMarkedParse(block.markdown);
  } else if (block.type === "code") {
    wrapper.className +=
      " rounded-xl overflow-hidden border border-zinc-800 bg-[#0d1117]";
    const lang = block.language || "text";
    const filename = block.filename
      ? `<div class="px-4 py-2 bg-zinc-900 text-xs text-zinc-400 font-mono border-b border-zinc-800">${block.filename}</div>`
      : "";
    wrapper.innerHTML = `
      ${filename}
      <div class="relative group">
        <pre class="p-4 overflow-x-auto text-sm m-0"><code class="language-${lang}">${escapeHTML(block.content || "")}</code></pre>
        <button onclick="navigator.clipboard.writeText(this.parentElement.querySelector('code').innerText)" class="absolute top-2 right-2 p-1.5 bg-zinc-800 text-zinc-400 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:text-white" title="Copy">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
        </button>
      </div>
    `;
    setTimeout(() => {
      try {
        hljs.highlightAll();
      } catch (e) {}
    }, 0);
  } else if (block.type === "file") {
    wrapper.className +=
      " bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex items-center justify-between";
    wrapper.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="p-2 bg-indigo-500/20 text-indigo-400 rounded-lg">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
        </div>
        <div>
          <p class="font-medium text-sm">${block.name} <span class="text-xs text-zinc-500">v${block.version}</span></p>
          <p class="text-xs text-zinc-500">${(block.size / 1024).toFixed(1)} KB • ${block.mime}</p>
        </div>
      </div>
      <a href="/api/files/${block.fileId}/download" class="bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-lg text-sm transition-colors" download>Download</a>
    `;
  } else if (block.type === "table") {
    wrapper.className += " overflow-x-auto rounded-xl border border-zinc-800";
    const headers = (block.columns || [])
      .map(
        (c) =>
          `<th class="px-4 py-3 bg-zinc-900 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-b border-zinc-800">${c.label}</th>`,
      )
      .join("");
    const rows = (block.rows || [])
      .map((r) => {
        const tds = (block.columns || [])
          .map(
            (c) =>
              `<td class="px-4 py-3 text-sm border-b border-zinc-800/50">${r[c.key] ?? ""}</td>`,
          )
          .join("");
        return `<tr class="hover:bg-zinc-800/30 transition-colors">${tds}</tr>`;
      })
      .join("");
    wrapper.innerHTML = `
      <table class="w-full text-left border-collapse">
        <thead><tr>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } else if (block.type === "chart") {
    wrapper.className +=
      " bg-zinc-900 p-4 rounded-xl border border-zinc-800 h-80";
    const canvasId = `chart-${id}`;
    wrapper.innerHTML = `<canvas id="${canvasId}"></canvas>`;

    setTimeout(() => {
      try {
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        new Chart(ctx, {
          type: block.kind,
          data: {
            labels: (block.data || []).map((d) => d[block.xKey]),
            datasets: (block.series || []).map((s, i) => ({
              label: s.label || s.key,
              data: (block.data || []).map((d) => d[s.key]),
              backgroundColor: `hsl(${i * 60 + 240}, 70%, 60%)`,
              borderColor: `hsl(${i * 60 + 240}, 70%, 60%)`,
              tension: 0.3,
            })),
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: "#a1a1aa" } } },
            scales: {
              x: { ticks: { color: "#a1a1aa" }, grid: { color: "#27272a" } },
              y: { ticks: { color: "#a1a1aa" }, grid: { color: "#27272a" } },
            },
          },
        });
      } catch (e) {
        console.warn("Chart render error:", e);
      }
    }, 100);
  } else if (block.type === "card") {
    const toneClasses = {
      neutral: "bg-zinc-900 border-zinc-800",
      info: "bg-blue-900/20 border-blue-800",
      success: "bg-emerald-900/20 border-emerald-800",
      warning: "bg-yellow-900/20 border-yellow-800",
      danger: "bg-red-900/20 border-red-800",
    };
    wrapper.className += ` border rounded-xl p-5 ${toneClasses[block.tone] || toneClasses.neutral}`;

    let actionsHtml = "";
    if (block.actions && block.actions.length > 0) {
      actionsHtml = `<div class="mt-4 flex flex-wrap gap-2">
        ${block.actions.map((a) => `<button onclick="document.getElementById('chat-input').value='${a.prompt}'; document.getElementById('send-btn').click();" class="bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg text-sm transition-colors">${a.label}</button>`).join("")}
      </div>`;
    }

    wrapper.innerHTML = `
      <h3 class="font-bold text-lg text-white">${block.title}</h3>
      ${block.subtitle ? `<p class="text-sm text-zinc-400 mb-2">${block.subtitle}</p>` : ""}
      ${block.markdown ? `<div class="prose prose-invert prose-sm max-w-none text-zinc-300">${safeMarkedParse(block.markdown)}</div>` : ""}
      ${actionsHtml}
    `;
  } else if (block.type === "choices") {
    wrapper.className += " bg-zinc-900 border border-zinc-800 rounded-xl p-5";
    wrapper.innerHTML = `
      <p class="font-medium text-white mb-4">${block.question}</p>
      <div class="flex flex-col gap-2">
        ${(block.options || [])
          .map(
            (opt) => `
          <button onclick="document.getElementById('chat-input').value='${opt.value || opt.label}'; document.getElementById('send-btn').click();" class="text-left px-4 py-3 bg-zinc-800 hover:bg-indigo-600 border border-zinc-700 hover:border-indigo-500 rounded-lg text-sm transition-all">
            ${opt.label}
          </button>
        `,
          )
          .join("")}
      </div>
    `;
  } else {
    wrapper.innerHTML = `<p class="text-zinc-500 italic">Unsupported block type: ${block.type}</p>`;
  }

  return wrapper;
}

function updateBlockDOM(key, block) {
  const wrapper = document.getElementById(`block-${key}`);
  if (!wrapper) return;

  if (block.type === "text") {
    wrapper.innerHTML = safeMarkedParse(block.markdown);
  } else if (block.type === "code") {
    const codeEl = wrapper.querySelector("code");
    if (codeEl) {
      codeEl.textContent = block.content || "";
      try {
        hljs.highlightElement(codeEl);
      } catch (e) {}
    }
  }
}

// === HELPERS ===
function appendUserMessage(text) {
  const div = document.createElement("div");
  div.className = "flex justify-end";
  div.innerHTML = `
    <div class="bg-indigo-600 text-white px-4 py-3 rounded-2xl rounded-tr-sm max-w-[80%] shadow-sm">
      <p class="whitespace-pre-wrap text-sm">${escapeHTML(text)}</p>
    </div>
  `;
  document.getElementById("chat-container").appendChild(div);
}

function appendSystemMessage(text, isError = false) {
  const div = document.createElement("div");
  div.className = "flex justify-start";
  div.innerHTML = `
    <div class="bg-red-900/30 text-red-200 border border-red-800/50 px-4 py-3 rounded-2xl rounded-tl-sm max-w-[80%] shadow-sm">
      <p class="text-sm">${escapeHTML(text)}</p>
    </div>
  `;
  document.getElementById("chat-container").appendChild(div);
}

function scrollToBottom() {
  const container = document.getElementById("chat-container");
  container.scrollTop = container.scrollHeight;
}

function escapeHTML(str) {
  return String(str).replace(
    /[&<>'"]/g,
    (tag) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[tag],
  );
}

// === FILE UPLOAD (Presigned URL Logic) ===
async function handleFileUpload(e) {
  const files = Array.from(e.target.files);
  if (!files.length || !currentSessionId) return;

  for (const file of files) {
    try {
      // 1. Presign
      const presignRes = await fetch("/api/files/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: currentSessionId,
          name: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size,
        }),
      });
      if (!presignRes.ok) throw new Error("Presign failed");
      const { fileId, uploadUrl } = await presignRes.json();

      // 2. Upload to R2
      await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });

      // 3. Complete
      const completeRes = await fetch(`/api/files/${fileId}/complete`, {
        method: "POST",
      });
      if (!completeRes.ok) throw new Error("Complete failed");

      pendingAttachments.push({ id: fileId, name: file.name });
      renderAttachmentPreview();
    } catch (err) {
      console.error("Upload error:", err);
      alert(`Gagal upload ${file.name}`);
    }
  }
  e.target.value = ""; // reset
}

function renderAttachmentPreview() {
  const container = document.getElementById("attachment-preview");
  if (pendingAttachments.length === 0) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = pendingAttachments
    .map(
      (f) => `
    <div class="flex items-center gap-2 bg-zinc-700 px-3 py-1.5 rounded-md text-xs">
      <span>${f.name}</span>
    </div>
  `,
    )
    .join("");
}
