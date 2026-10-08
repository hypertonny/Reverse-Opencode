const tests = [
  { name: "test-default", body: { parts: [{ type: "text", text: "Say 1" }] } },
  { name: "test-agent-build", body: { agent: "build", parts: [{ type: "text", text: "Say 2" }] } },
  { name: "test-agent-general", body: { agent: "general", parts: [{ type: "text", text: "Say 3" }] } },
  { name: "test-agent-explore", body: { agent: "explore", parts: [{ type: "text", text: "Say 4" }] } },
  { name: "test-agent-plan", body: { agent: "plan", parts: [{ type: "text", text: "Say 5" }] } },
  { name: "test-agent-title", body: { agent: "title", parts: [{ type: "text", text: "Say 6" }] } },
];

for (const t of tests) {
  try {
    const sRes = await fetch("http://127.0.0.1:4096/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t.name }),
    });
    const sData = await sRes.json();
    const sid = sData.id;

    const payload = {
      ...t.body,
      model: { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
    };

    const mRes = await fetch(`http://127.0.0.1:4096/session/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const mData = await mRes.json();
    const err = mData.info?.error?.data?.responseBody || mData.info?.error?.message;
    const txt = mData.parts?.find((p: any) => p.type === "text")?.text;
    console.log(`${t.name}:`, err ? `ERROR: ${err}` : `SUCCESS: ${txt?.slice(0, 50)}`);

    await fetch(`http://127.0.0.1:4096/session/${sid}`, { method: "DELETE" });
  } catch (e: any) {
    console.log(`${t.name} EXCEPTION:`, e.message);
  }
}
