export const meta = {
  name: "hello",
  description:
    "Test fixture: a default agent and a plugin agent type, both with a schema",
  phases: [{ title: "Greet" }, { title: "Verify" }]
};

const GREETING = {
  type: "object",
  properties: { greeting: { type: "string" } },
  required: ["greeting"]
};

const TOOLS = {
  type: "object",
  properties: {
    has_agent: { type: "boolean" },
    has_write: { type: "boolean" }
  },
  required: ["has_agent", "has_write"]
};

phase("Greet");
const hello = await agent(`Say hello to ${args?.name ?? "world"}.`, {
  label: "greet",
  schema: GREETING
});

phase("Verify");
let tools = null;
try {
  tools = await agent("Report whether you have the Agent and Write tools.", {
    label: "verify",
    agentType: "esp-skills:esp-verifier",
    schema: TOOLS
  });
} catch (error) {
  log(`verifier failed: ${error.message}`);
}

log("done");
return {
  checks: {
    greeting: hello?.greeting ?? null,
    verifier_ran: tools !== null,
    verifier_has_agent: tools?.has_agent ?? null,
    verifier_has_write: tools?.has_write ?? null
  }
};
