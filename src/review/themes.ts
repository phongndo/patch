import { registerCustomTheme } from "@pierre/diffs";

// One restrained palette for both the WASM backend and its JS fallback.
for (const dark of import.meta.hot?.data.registered ? [] : [false, true]) {
  const name = dark ? "patch-dark" : "patch-light";
  const background = dark ? "#191d1b" : "#ffffff";
  const foreground = dark ? "#d4ded5" : "#354039";
  const colors = {
    comment: dark ? "#7f9083" : "#8b9287",
    keyword: dark ? "#d3a2a1" : "#965b60",
    string: dark ? "#b3c59d" : "#627b47",
    number: dark ? "#d2bd91" : "#997849",
    function: dark ? "#9bb9cd" : "#4d7189",
    type: dark ? "#b6a8cc" : "#7d668f",
    property: dark ? "#b2c9c4" : "#47675e",
    operator: dark ? "#a4b0a7" : "#68736b",
  };
  const groups: Record<keyof typeof colors, string[]> = {
    comment: ["comment", "comment.doc"],
    keyword: ["keyword", "keyword.control", "keyword.directive", "tag", "tag_name"],
    string: ["string", "string.escape", "string.regex", "string.special", "string.special.symbol"],
    number: ["number", "boolean", "constant", "value", "number.unit"],
    function: [
      "function",
      "function.method",
      "function.builtin",
      "function.special.definition",
      "function.call",
    ],
    type: ["type", "type.builtin", "constructor", "class", "class_name"],
    property: ["property", "property.definition", "property_name", "variable.member"],
    operator: [
      "keyword.operator",
      "operator",
      "punctuation",
      "punctuation.bracket",
      "punctuation.delimiter",
    ],
  };
  registerCustomTheme(
    name,
    async () => ({
      name,
      appearance: dark ? "dark" : "light",
      style: {
        background,
        text: foreground,
        "editor.background": background,
        "editor.foreground": foreground,
        created: dark ? "#85bb97" : "#37845c",
        deleted: dark ? "#d28f87" : "#bc6c67",
        syntax: {
          variable: { color: foreground },
          "variable.parameter": { color: foreground },
          ...Object.fromEntries(
            Object.entries(groups).flatMap(([group, tokens]) =>
              tokens.map((token) => [token, { color: colors[group as keyof typeof colors] }]),
            ),
          ),
        },
      },
    }),
    "zed",
  );
  registerCustomTheme(name, async () => ({
    name,
    type: dark ? "dark" : "light",
    colors: { "editor.background": background, "editor.foreground": foreground },
    tokenColors: Object.entries(colors).map(([scope, foreground]) => ({
      scope,
      settings: { foreground },
    })),
  }));
}

if (import.meta.hot) import.meta.hot.data.registered = true;
