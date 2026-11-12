const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("halaman awal melindungi aplikasi; daftar langsung masuk; logout dan login kembali", async () => {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) {
      const classes = new Set(selector === "#appShell" ? ["hidden"] : []);
      elements.set(selector, { value: "", innerHTML: "", textContent: "", disabled: false,
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c), toggle: (c, enabled) => enabled ? classes.add(c) : classes.delete(c) },
        showModal() { this.open = true; }, close() { this.open = false; },
        click() { this.onclick(); }, reset() {}, reportValidity: () => true });
    }
    return elements.get(selector);
  }
  let signedIn = null;
  let fields = { name: "Rani", email: "rani@student.ub.ac.id", password: "password123", nim: "123456789", consent: "on" };
  const requests = [];
  const context = {
    console, URLSearchParams, setTimeout, window: {}, location: { search: "" },
    sessionStorage: { setItem() {}, removeItem() {} },
    document: { querySelector: element, querySelectorAll: () => [] },
    FormData: class { get(k) { return fields[k]; } [Symbol.iterator]() { return Object.entries(fields)[Symbol.iterator](); } },
    fetch: async (url, options) => {
      requests.push(url);
      let result;
      if (url === "/api/auth/me") result = signedIn;
      else if (url === "/api/health") result = { demoTools: true };
      else if (url === "/api/users") {
        const body = JSON.parse(options.body); assert.equal(body.password, "password123");
        signedIn = { id: 1, name: body.name }; result = signedIn;
      } else if (url === "/api/auth/logout") { signedIn = null; result = { ok: true }; }
      else if (url === "/api/auth/login") { signedIn = { id: 1, name: "Rani" }; result = signedIn; }
      else if (url === "/api/examples/account") result = { ok: true };
      else if (url === "/api/events") result = [];
      else throw new Error(`Unexpected request ${url}`);
      return { ok: true, json: async () => result };
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/app.js"), "utf8"), context);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(element("#appShell").classList.contains("hidden"), true);
  assert.equal(element("#welcome").classList.contains("hidden"), false);
  assert.equal(requests.includes("/api/events"), false);
  assert.equal(requests.includes("/api/examples/session"), false);
  await context.openTab("orders");
  assert.equal(requests.includes("/api/my/orders"), false);
  element("#welcomeRegister").click();
  assert.equal(element("#regDlg").open, true);
  await element("#regForm").onsubmit({ preventDefault() {} });
  assert.equal(element("#regDlg").open, false);
  assert.equal(element("#appShell").classList.contains("hidden"), false);
  assert.equal(element("#welcome").classList.contains("hidden"), true);
  assert.match(element("#currentUser").textContent, /Rani/);
  assert.equal(requests.includes("/api/examples/account"), true);
  await element("#btnLogout").onclick();
  assert.equal(element("#appShell").classList.contains("hidden"), true);
  assert.equal(element("#welcome").classList.contains("hidden"), false);
  fields = { email: fields.email, password: fields.password };
  element("#welcomeLogin").click();
  assert.equal(element("#loginDlg").open, true);
  await element("#loginForm").onsubmit({ preventDefault() {} });
  assert.equal(element("#appShell").classList.contains("hidden"), false);
  assert.equal(element("#loginDlg").open, false);
});
