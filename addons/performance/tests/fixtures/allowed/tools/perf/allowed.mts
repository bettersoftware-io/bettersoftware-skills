export default {
  animations: [
    {
      file: "src/button.css",
      rule: ".button:hover",
      property: "background-color",
      reason: "Hover feedback. Runs on a pointer event, never on live data.",
    },
  ],
};
