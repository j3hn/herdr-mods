// The pi session running in the focused pane, as a reading copy: the discussion, with Pi's
// thinking and tool calls folded to one line each until asked for, and a filter bar that hides
// them altogether so only the discussion is left.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  checking,
  exec,
  focused,
  home,
  panes,
  readTextFile,
  spaces,
  theme,
  watchFolder,
  window,
} from "herdr";
import {
  argSummary,
  buildRows,
  encodeDir,
  summarize,
  timeFromName,
  visibleSteps,
} from "./parse.js";

const FILTERS = "session.filters.v2";
const PAGE = 200; // rows drawn at once; older ones on request
const SAID = 8000; // characters of one message drawn
const RESULT = 3000; // characters of one tool result drawn
const HEAD = 4096; // bytes of a session read for its first record
const TAIL = 4000000; // bytes of a long session read: readTextFile stops at 1 MiB
const SWEEP = 8000; // ms between safety looks, in case a change is missed
const CANDIDATES = 20;
const KEEP = 3000; // records kept; older ones are outside any window worth drawing

function savedFilters() {
  try {
    const value = JSON.parse(localStorage.getItem(FILTERS) ?? "null");
    if (value && typeof value === "object") {
      return { calls: value.calls !== false, thinking: value.thinking !== false };
    }
  } catch {
    // A corrupt value means the defaults.
  }
  return { calls: true, thinking: true };
}

/** Where pi runs: the focused pane's folder. Focused on this panel instead, the folder of the
 *  terminals beside it, so the panel keeps reading the session it was opened next to. */
function currentFolder() {
  const f = focused();
  const all = panes();
  const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
  const own = pane?.cwd ?? f?.cwd;
  if (own) return own;
  const beside = f?.tab ? all.find((p) => p.tab === f.tab && p.cwd) : null;
  if (beside?.cwd) return beside.cwd;
  const space = spaces().find((s) => s.id === (f?.space ?? null)) ?? spaces().find((s) => s.active);
  const inside = space ? all.find((p) => p.cwd && space.tabs.some((tab) => tab.id === p.tab)) : null;
  return inside?.cwd ?? space?.folder ?? home();
}

const sessionsRoot = () => `${home()}/.pi/agent/sessions`;

function clock(at) {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function clipped(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… ${value.length - limit} more characters`;
}

/** Text as one element per line, so line breaks and code stay where they were. */
function lines(text, size, color) {
  return String(text ?? "")
    .split("\n")
    .map((line) => div().text_size(size).text_color(color).whitespace_normal().child(line === "" ? "\u00a0" : line));
}

function shortFolder(path) {
  const clean = String(path ?? "").replace(/[/\\]+$/, "");
  if (clean === home()) return "~";
  return clean.split(/[/\\]/).filter(Boolean).pop() ?? clean;
}

/** The file's size in bytes, or null when it cannot be read. */
async function sizeOf(path) {
  const result = await exec("sh", ["-c", 'wc -c < "$1"', "size", path]);
  const size = Number(result.stdout.trim());
  return result.code === 0 && Number.isFinite(size) ? size : null;
}

export default class Session extends View {
  init(_props, cx) {
    this.filters = savedFilters();
    this.open = new Set(); // the folded rows someone opened
    this.openCalls = new Set(); // the tool calls whose result someone opened
    this.messages = []; // the session's records, in file order
    this.rows = []; // those as the rows drawn
    this.meta = null; // the session record: its id, folder and time
    this.text = null; // the file as last read, when it fits in one read
    this.parsed = 0; // how much of it went through a newline
    this.size = 0; // its size in bytes at that read
    this.large = false; // too big for one read: only its tail is shown
    this.partial = null; // the tail window's last, unfinished line
    this.tail = null; // the tail window as last read
    this.session = null; // the file shown
    this.picked = null; // the file someone chose, if they did
    this.candidates = []; // the folder's other sessions
    this.folder = null; // the folder the panel follows
    this.limit = PAGE;
    this.picking = false;
    this.loading = false;
    this.error = null;

    if (checking()) return;
    this.folder = currentFolder();
    this.reload(cx);
    this.follow(cx);
    cx.timer.every(SWEEP, (cx) => this.sweep(cx));
  }

  /** A change anywhere in the sessions folder: read the file again. */
  follow(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        let watch = null;
        try {
          watch = watchFolder(sessionsRoot());
          this.watch = watch;
          await watch;
        } catch {
          await cx.sleep(3000);
        } finally {
          if (this.watch === watch) this.watch = null;
        }
        if (this.session) this.refresh(cx);
      }
    });
  }

  /** Follow the focused pane, and catch anything a watch missed. */
  sweep(cx) {
    if (checking() || window()?.visible === false) return;
    if (currentFolder() !== this.folder) {
      this.enter(cx);
      return;
    }
    this.refresh(cx);
  }

  /** One look at the file at a time, whichever asked for it. */
  refresh(cx) {
    if (!this.session || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        await this.load(cx);
      } catch (error) {
        this.error = String(error);
        cx.notify();
      } finally {
        this.loading = false;
      }
    });
  }

  /** Another folder: start over with its newest session. */
  enter(cx) {
    this.watch?.cancel();
    this.folder = currentFolder();
    this.session = null;
    this.picked = null;
    this.candidates = [];
    this.text = null;
    this.parsed = 0;
    this.size = 0;
    this.large = false;
    this.partial = null;
    this.tail = null;
    this.messages = [];
    this.rows = [];
    this.meta = null;
    this.limit = PAGE;
    this.picking = false;
    this.error = null;
    this.open.clear();
    this.openCalls.clear();
    this.reload(cx);
  }

  /** Find this folder's sessions, then read the newest (or the one someone chose). */
  reload(cx) {
    const folder = this.folder ?? home();
    cx.spawn(async (cx) => {
      const dir = `${sessionsRoot()}/${encodeDir(folder)}`;
      let names = [];
      try {
        const listing = await exec("ls", ["-1t", dir]);
        if (listing.code === 0) names = listing.stdout.split("\n").filter((name) => name.endsWith(".jsonl"));
      } catch {
        // No session folder for this folder yet.
      }
      if (folder !== this.folder) return;
      this.candidates = names
        .slice(0, CANDIDATES)
        .map((name) => ({ name, path: `${dir}/${name}`, at: timeFromName(name) }));
      if (!this.session) this.session = this.picked ?? this.candidates[0]?.path ?? null;
      if (!this.session) {
        // Nothing in this folder: the newest session anywhere, marked as another folder's.
        try {
          const newest = await exec("sh", [
            "-c",
            'ls -1t "$1"/*/*.jsonl 2>/dev/null | head -1',
            "sessions",
            sessionsRoot(),
          ]);
          const path = newest.code === 0 ? newest.stdout.trim() : "";
          if (path && folder === this.folder && !this.session) this.session = this.picked ?? path;
        } catch {
          // Nothing at all.
        }
      }
      await this.load(cx);
      cx.notify();
    });
  }

  /** Read the file and keep the rows in step. */
  async load(cx) {
    const path = this.session;
    if (!path) return;
    if (this.large) return this.loadTail(cx, path);
    let text;
    try {
      text = await readTextFile(path);
    } catch (error) {
      // A long session: readTextFile stops at 1 MiB, so read its tail instead.
      if (String(error).includes("exceeds")) {
        this.large = true;
        return this.loadTail(cx, path);
      }
      this.error = String(error);
      cx.notify();
      return;
    }
    if (path !== this.session) return;
    if (text === null) {
      this.session = null;
      this.error = "That session file is gone.";
      cx.notify();
      return;
    }
    this.error = null;
    this.size = text.length;
    if (!this.append(text)) return;
    this.rows = buildRows(this.messages);
    cx.notify();
  }

  /** A session past one read: its first record and its newest bytes. */
  async loadTail(cx, path) {
    let size;
    try {
      size = await sizeOf(path);
    } catch (error) {
      this.error = String(error);
      cx.notify();
      return;
    }
    if (size === null || path !== this.session) return;
    if (size === this.size && this.messages.length > 0) return;
    const replaced = size < this.size;
    const grown = replaced ? 0 : size - this.size;
    const before = this.size;
    try {
      const wants = [exec("sh", ["-c", 'tail -c "$2" "$1"', "tail", path, String(TAIL)])];
      if (!this.meta || replaced) wants.push(exec("sh", ["-c", 'head -c "$2" "$1"', "head", path, String(HEAD)]));
      const [tail, head] = await Promise.all(wants);
      if (path !== this.session) return;
      if (tail.code !== 0) {
        this.error = tail.stderr.trim() || "Cannot read this session";
        cx.notify();
        return;
      }
      this.size = size;
      if (replaced) {
        this.messages = [];
        this.meta = null;
        this.partial = null;
        this.tail = null;
      }
      const first = head?.code === 0 ? head.stdout.split("\n")[0] : null;
      if (first && !this.meta) {
        try {
          const record = JSON.parse(first);
          if (record.type === "session") this.meta = { id: record.id, cwd: record.cwd, at: record.timestamp };
        } catch {
          // A first line that does not parse is no loss.
        }
      }
      const windowed = size > TAIL;
      let body = tail.stdout;
      // A window that starts mid-line drops that line.
      if (windowed) body = body.slice(body.indexOf("\n") + 1);
      // Parse only what arrived since the last look: a window that slid by as much as the file grew
      // still holds the old one, which the check below proves before anything is skipped.
      let added = null;
      if (this.tail !== null && !replaced) {
        const slide = windowed ? this.tail.slice(Math.min(grown, this.tail.length)) : this.tail;
        if (body.startsWith(slide)) added = body.slice(slide.length);
      }
      if (added === null) {
        this.messages = [];
        this.partial = null;
        this.ingestLines(body);
      } else {
        this.ingestLines(added);
      }
      this.tail = body;
      if (this.messages.length > KEEP) this.messages.splice(0, this.messages.length - KEEP);
      this.error = null;
      this.rows = buildRows(this.messages);
      cx.notify();
    } catch (error) {
      this.size = before;
      this.error = String(error);
      cx.notify();
    }
  }

  /** Records from the complete lines of a chunk; its last, unfinished line waits for the next. */
  ingestLines(chunk) {
    if (!chunk) return false;
    const text = (this.partial ?? "") + chunk;
    const end = text.lastIndexOf("\n") + 1;
    this.partial = text.slice(end);
    return this.ingest(text.slice(0, end));
  }

  /** Add whatever the file gained. True when there is something new to draw. */
  append(text) {
    const same = this.text !== null && text.length >= this.text.length && text.startsWith(this.text);
    let changed = !same;
    if (!same) {
      this.messages = [];
      this.meta = null;
      this.parsed = 0;
    }
    const end = text.lastIndexOf("\n") + 1;
    if (end > this.parsed) {
      changed = this.ingest(text.slice(this.parsed, end)) || changed;
      this.parsed = end;
    }
    this.text = text;
    return changed;
  }

  /** Records from complete lines of the session file. True when any were kept. */
  ingest(chunk) {
    let changed = false;
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === "session") {
        this.meta = { id: record.id, cwd: record.cwd, at: record.timestamp };
        changed = true;
      } else if (record.type === "message" && record.message) {
        this.messages.push({ id: record.id, at: record.timestamp, message: record.message });
        changed = true;
      }
    }
    return changed;
  }

  /** Show one of the folder's other sessions. */
  pick(path, cx) {
    this.session = path;
    this.picked = path;
    this.picking = false;
    this.text = null;
    this.parsed = 0;
    this.size = 0;
    this.large = false;
    this.partial = null;
    this.tail = null;
    this.messages = [];
    this.rows = [];
    this.meta = null;
    this.limit = PAGE;
    this.open.clear();
    this.openCalls.clear();
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        await this.load(cx);
      } catch (error) {
        this.error = String(error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  render(cx) {
    if (!checking() && currentFolder() !== this.folder) this.enter(cx);
    const t = theme();
    const away = Boolean(this.meta?.cwd && this.folder && this.meta.cwd !== this.folder);
    const where = away ? shortFolder(this.meta?.cwd) : this.folder ? shortFolder(this.folder) : "";
    const when = this.meta?.at ? clock(this.meta.at) : timeFromName(this.session?.split("/").pop());
    // What the line beside the folder says: whose session this is, or how much of it is shown.
    const note = away ? "other folder" : this.large ? "newest part" : when || "no session";
    const shown = this.rows.slice(Math.max(0, this.rows.length - this.limit));

    const body = [];
    if (this.rows.length > shown.length) {
      body.push(
        div()
          .id("session-earlier")
          .h(26)
          .px(10)
          .cursor_pointer()
          .rounded(6)
          .text_size(11.5)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.limit += PAGE;
            cx.notify();
          })
          .child(`Show ${Math.min(PAGE, this.rows.length - shown.length)} earlier rows`),
      );
    }
    for (const row of shown) {
      const element = this.row(row, t);
      if (element) body.push(element);
    }

    return v_flex()
      .id("session")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(40)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(where || "Session"))
          .child(
            h_flex()
              .id("session-pick")
              .gap(5)
              .items_center()
              .px(6)
              .h(22)
              .rounded(6)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.picking = !this.picking;
                cx.notify();
              })
              .child(div().text_size(11).text_color(t.dim).child(note))
              .child(div().text_size(9).text_color(t.dim).child(this.picking ? "▾" : "▸")),
          ),
      )
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(this.chip("calls", "Tool calls", t))
          .child(this.chip("thinking", "Thinking", t))
          .child(div().flex_1())
          .when(!this.filters.calls && !this.filters.thinking, (el) =>
            el.child(div().text_size(11).text_color(t.dim).child("discussion only")),
          ),
      )
      .when(this.picking, (el) => el.child(this.picker(t)))
      .child(
        v_flex()
          .id("session-rows")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .py(4)
          .gap(1)
          .children(body)
          .when(body.length === 0, (el) =>
            el.child(
              div()
                .p(12)
                .text_size(12)
                .text_color(t.dim)
                .child(this.error ?? (this.session ? "Loading the session…" : "No pi session in this folder yet.")),
            ),
          ),
      )
      .when(Boolean(this.error) && body.length > 0, (el) =>
        el.child(div().flex_none().px(12).py(6).text_size(11).text_color(t.blocked).child(this.error)),
      );
  }

  chip(key, label, t) {
    const on = this.filters[key] === true;
    return h_flex()
      .id(`filter-${key}`)
      .h(22)
      .px(8)
      .gap(5)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .border_1()
      .border_color(on ? t.accent : t.border)
      .text_size(11.5)
      .text_color(on ? t.accent : t.dim)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.filters = { ...this.filters, [key]: !on };
        try {
          localStorage.setItem(FILTERS, JSON.stringify(this.filters));
        } catch {
          // Not remembering it is better than not toggling it.
        }
        cx.notify();
      })
      .child(div().text_size(8).child(on ? "●" : "○"))
      .child(label);
  }

  picker(t) {
    const rows = this.candidates.slice(0, 12).map((candidate) =>
      h_flex()
        .id(`pick-${candidate.name}`)
        .h(24)
        .px(8)
        .gap(8)
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.pick(candidate.path, cx))
        .child(div().w(34).text_size(11).text_color(t.dim).child(candidate.at))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11.5)
            .text_color(candidate.path === this.session ? t.accent : t.foreground)
            .child(candidate.name.split("_").pop()?.replace(".jsonl", "").slice(0, 8) ?? candidate.name),
        )
        .when(candidate.path === this.session, (el) =>
          el.child(div().text_size(10).text_color(t.accent).child("shown")),
        ),
    );
    return v_flex()
      .id("session-picker")
      .flex_none()
      .p(6)
      .gap(2)
      .border_b(1)
      .border_color(t.border)
      .children(rows)
      .when(rows.length === 0, (el) =>
        el.child(div().p(6).text_size(11).text_color(t.dim).child("No sessions in this folder")),
      );
  }

  row(row, t) {
    if (row.kind === "user" || row.kind === "say") {
      const you = row.kind === "user";
      return v_flex()
        .id(`say-${row.key}`)
        .flex_none()
        .px(12)
        .py(6)
        .gap(2)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().text_size(10.5).font_semibold().text_color(you ? t.accent : t.muted).child(you ? "You" : "Pi"))
            .when(Boolean(clock(row.at)), (el) =>
              el.child(div().text_size(10).text_color(t.dim).child(clock(row.at))),
            ),
        )
        .child(v_flex().gap(0).children(lines(clipped(row.text, SAID), 12.5, t.foreground)));
    }
    if (row.kind === "work") return this.work(row, t);
    return null;
  }

  /** Thinking and tool calls between two of Pi's words: one folded line, opened by a click. */
  work(row, t) {
    const steps = visibleSteps(row.steps, this.filters);
    if (steps.length === 0) return null;
    const open = this.open.has(row.key);
    const head = h_flex()
      .id(`work-${row.key}`)
      .flex_none()
      .h(24)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (this.open.has(row.key)) this.open.delete(row.key);
        else this.open.add(row.key);
        cx.notify();
      })
      .child(div().w(9).text_size(9).text_color(t.dim).child(open ? "▾" : "▸"))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .text_color(t.muted)
          .child(summarize(row.steps, this.filters)),
      );
    if (!open) return head;
    return v_flex()
      .id(`work-open-${row.key}`)
      .flex_none()
      .gap(1)
      .children([head, ...steps.map((step) => (step.type === "call" ? this.call(step, t) : this.thought(step, t)))]);
  }

  thought(step, t) {
    return v_flex()
      .id(`thought-${step.key}`)
      .flex_none()
      .pl(24)
      .pr(10)
      .pb(4)
      .gap(1)
      .child(div().text_size(10).text_color(t.dim).child("Thought"))
      .child(
        v_flex()
          .pl(8)
          .gap(0)
          .border_l(2)
          .border_color(t.border)
          .children(lines(clipped(step.text, SAID), 11.5, t.muted)),
      );
  }

  call(step, t) {
    const open = this.openCalls.has(step.key);
    const head = h_flex()
      .id(`call-${step.key}`)
      .flex_none()
      .h(24)
      .pl(24)
      .pr(10)
      .gap(6)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (this.openCalls.has(step.key)) this.openCalls.delete(step.key);
        else this.openCalls.add(step.key);
        cx.notify();
      })
      .child(div().text_size(9).text_color(t.dim).child(open ? "▾" : "▸"))
      .child(div().text_size(11.5).font_medium().text_color(step.isError ? t.blocked : t.foreground).child(step.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(argSummary(step.args)))
      .when(step.result === null, (el) => el.child(div().text_size(10).text_color(t.dim).child("running")))
      .when(step.isError, (el) => el.child(div().text_size(10).text_color(t.blocked).child("failed")));
    if (!open) return head;
    const result = step.result === null ? "No result yet." : clipped(step.result, RESULT);
    return v_flex()
      .id(`call-open-${step.key}`)
      .flex_none()
      .gap(2)
      .children([
        head,
        v_flex()
          .id(`result-${step.key}`)
          .ml(24)
          .mr(10)
          .mb(4)
          .p(8)
          .rounded(6)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .gap(0)
          .children(lines(result, 11, step.isError ? t.blocked : t.muted)),
      ]);
  }
}
