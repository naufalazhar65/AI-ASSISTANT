/**
 * Pixel-office DOM panels: Chat, Tasks, Inspector, SystemLog + SSE room sync.
 * No framework. Pure helpers (emoteFor, fmtTaskLine, fmtEventLine,
 * taskTitleFor, isBusFrame) are unit-tested; DOM access happens only inside
 * bootPanels() and helpers guarded for non-DOM environments.
 */
/** Status → emote bubble glyph (reference: AgentOffice emote bubbles). */
export function emoteFor(status) {
    switch (status) {
        case "typing": return "💻";
        case "reading": return "📖";
        case "thinking": return "💭";
        case "walking": return "🚶";
        case "working": return "🔧";
        case "waiting": return "⏳";
        case "success": return "😌";
        case "error": return "⚠️";
        default: return "💬";
    }
}
/** One-line task row for the TaskBoard panel. */
export function fmtTaskLine(t) {
    const where = t.station ? ` @${t.station}` : "";
    return `${emoteFor(t.state)} [${t.id}] ${t.title} — ${t.actor}${where} · ${t.state}`;
}
/** One-line log row for the SystemLog panel. Unknown shapes degrade safely. */
export function fmtEventLine(e) {
    const who = e.actor ? `${e.actor} ` : "";
    const kind = e.type || "event";
    const what = e.summary || kind;
    return `${who}${kind}: ${what}`.slice(0, 200);
}
/** Display title for a task row: explicit title, else id. */
export function taskTitleFor(id, title) {
    const t = (title || "").trim();
    return t || id;
}
/** Structural guard for SSE frames (mirrors the old Canvas viewer). */
export function isBusFrame(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const o = v;
    if (typeof o.type !== "string")
        return false;
    for (const k of ["actor", "agent", "station", "task_id"]) {
        if (o[k] !== undefined && typeof o[k] !== "string")
            return false;
    }
    return true;
}
function el(id) {
    if (typeof document === "undefined")
        return null;
    return document.getElementById(id);
}
function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Append a chat line. Speaker is owner text or agent name; never raw HTML. */
export function appendChat(p, speaker, text) {
    const div = document.createElement("div");
    div.className = "chat-line";
    div.innerHTML = `<b>${esc(speaker)}</b> ${esc(text)}`;
    p.chatLog.appendChild(div);
    p.chatLog.scrollTop = p.chatLog.scrollHeight;
}
/** Re-render the TaskBoard from the task map. */
export function renderTasks(p, tasks) {
    p.taskList.innerHTML = "";
    for (const t of tasks.values()) {
        const div = document.createElement("div");
        div.className = "task-row";
        div.textContent = fmtTaskLine(t);
        p.taskList.appendChild(div);
    }
}
/** Re-render SystemLog (cap 120 rows). */
export function renderLog(p, lines) {
    p.sysLog.innerHTML = "";
    for (const line of lines.slice(-120)) {
        const div = document.createElement("div");
        div.className = "log-row";
        div.textContent = line;
        p.sysLog.appendChild(div);
    }
}
/** Inspector shows the selected avatar/task detail. */
export function renderInspector(p, sel) {
    if (!sel) {
        p.inspector.textContent = "Klik avatar untuk follow + detail.";
        return;
    }
    p.inspector.textContent =
        sel.kind === "avatar"
            ? `${sel.id}\nstatus: ${sel.status} ${emoteFor(sel.status)}\nstation: ${sel.station ?? "-"}\ntask: ${sel.task ?? "-"}`
            : `${sel.task.id}\n${sel.task.title}\nactor: ${sel.task.actor}\nstate: ${sel.task.state}`;
}
function hooks() {
    return (window ?? {});
}
/** Boot panels: wire chat form, SSE room sync, and selection hook. */
/** Delegation command shape: "suruh <agent> <task>" hits the server's
 *  explicit-delegation patterns, so TaskBoard Assign flows produce genuine
 *  delegation events (agent_delegated/task_assigned) like typed chat does. */
export function assignCommand(agent, text) {
    return `suruh ${agent} ${text}`;
}
/** Send one owner turn through the real chat pipeline (POST /api/llm). */
function sendChat(p, user, text) {
    appendChat(p, "owner", text);
    const h = hooks();
    if (typeof h.__officeSelect === "function") {
        try {
            h.__officeSelect(null);
        }
        catch {
            // ignore
        }
    }
    void (async () => {
        try {
            const res = await fetch("/api/llm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: [{ role: "user", content: text }],
                    user,
                }),
            });
            const reply = (await res.text()).trim() || "(no reply)";
            appendChat(p, "Mia", reply);
        }
        catch {
            appendChat(p, "Mia", "(offline — backend tidak terjangkau)");
        }
    })();
}
export function bootPanels(user) {
    const chatLog = el("chat-log");
    const chatForm = el("chat-form");
    const chatInput = el("chat-input");
    const taskList = el("task-list");
    const inspector = el("inspector");
    const sysLog = el("sys-log");
    if (!chatLog || !chatForm || !chatInput || !taskList || !inspector || !sysLog)
        return;
    const p = { chatLog, chatForm, chatInput, taskList, inspector, sysLog };
    const tasks = new Map();
    const logLines = [];
    const pushLog = (line) => {
        logLines.push(line);
        renderLog(p, logLines);
    };
    const taskKey = (taskId, actor) => taskId || `live-${actor || "mia"}`;
    const applyToPanels = (ev) => {
        const actor = ev.actor || ev.agent || "mia";
        if (ev.type === "task_assigned" || ev.type === "task_created" || ev.type === "task_started") {
            const key = taskKey(ev.task_id, actor);
            const prev = tasks.get(key);
            tasks.set(key, {
                id: key,
                title: taskTitleFor(key, prev?.title || ev.summary),
                actor,
                station: ev.station ?? prev?.station ?? null,
                state: ev.type === "task_assigned" ? "walking" : "thinking",
            });
            renderTasks(p, tasks);
        }
        else if (ev.type === "tool_called" || ev.type === "file_read" || ev.type === "file_written") {
            const key = taskKey(ev.task_id, actor);
            const prev = tasks.get(key);
            tasks.set(key, {
                id: key,
                title: taskTitleFor(key, prev?.title || ev.summary || "working"),
                actor,
                station: ev.station ?? prev?.station ?? null,
                state: ev.type === "file_read" ? "reading" : "typing",
            });
            renderTasks(p, tasks);
        }
        else if (ev.type === "waiting_input") {
            const key = taskKey(ev.task_id, actor);
            const prev = tasks.get(key);
            if (prev) {
                prev.state = "waiting";
                renderTasks(p, tasks);
            }
        }
        else if (ev.type === "task_done" || ev.type === "task_failed" || ev.type === "task_cancelled") {
            const key = taskKey(ev.task_id, actor);
            const prev = tasks.get(key);
            if (prev) {
                prev.state = ev.type === "task_done" ? "success" : "error";
                renderTasks(p, tasks);
            }
        }
        pushLog(fmtEventLine({ type: ev.type, actor, summary: ev.summary }));
        const h = hooks();
        if (typeof h.__officeApply === "function") {
            try {
                h.__officeApply(ev);
            }
            catch {
                // Viewer sync is best-effort; panels already updated.
            }
        }
    };
    chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text)
            return;
        chatInput.value = "";
        sendChat(p, user, text);
    });
    // TaskBoard Assign row (persistent sibling of the re-rendered task list):
    // type a task once, send it to Michelle (coding) or Agnes (research)
    // through the SAME chat pipeline → real delegation events fire and the
    // avatar walks. renderTasks wipes taskList.innerHTML, so this row lives
    // OUTSIDE it and survives re-renders.
    const assignRow = document.createElement("div");
    assignRow.id = "task-assign";
    const assignInput = document.createElement("input");
    assignInput.placeholder = "Tugas untuk didelegasikan…";
    assignInput.setAttribute("aria-label", "Tugas untuk didelegasikan");
    const assignMichelle = document.createElement("button");
    assignMichelle.type = "button";
    assignMichelle.textContent = "＋ Michelle";
    const assignAgnes = document.createElement("button");
    assignAgnes.type = "button";
    assignAgnes.textContent = "＋ Agnes";
    assignRow.append(assignInput, assignMichelle, assignAgnes);
    taskList.parentElement?.append(assignRow);
    const sendAssign = (agent) => {
        const t = assignInput.value.trim();
        if (!t)
            return;
        assignInput.value = "";
        sendChat(p, user, assignCommand(agent, t));
    };
    assignMichelle.addEventListener("click", () => sendAssign("michelle"));
    assignAgnes.addEventListener("click", () => sendAssign("agnes"));
    const src = new EventSource(`/api/bus/stream?user=${encodeURIComponent(user)}`);
    src.onmessage = (msg) => {
        try {
            const ev = JSON.parse(msg.data);
            if (!isBusFrame(ev))
                return;
            applyToPanels(ev);
        }
        catch {
            // A malformed frame must never break the panels.
        }
    };
    src.onerror = () => {
        pushLog("room stream reconnecting…");
    };
    const h = hooks();
    if (typeof h.__officeSnapshot === "function") {
        setInterval(() => {
            try {
                const avs = h.__officeSnapshot();
                const first = avs[0];
                if (first) {
                    renderInspector(p, {
                        kind: "avatar",
                        id: first.id,
                        status: first.status,
                        station: first.station,
                        task: first.task,
                    });
                }
            }
            catch {
                // ignore
            }
        }, 2000);
    }
    void h;
}
