import { describe, it } from "vitest";
import { normalizeModelName } from "../src/utils/model-utils";

// Just logging the results for inspection
describe("Model Alias Test", () => {
  it("logs model normalization results", () => {
    const testModels = [
      "claude-3",
      "claude-3.5",
      "claude-3.7",
      "claude-3-5",
      "claude-3-7",
      "claude-3-opus",
      "claude-3-sonnet",
      "claude-3-haiku",
      "claude-3-5-sonnet",
      "claude-3-5-haiku",
      "claude-3-7-sonnet",
      "claude-3.5-sonnet",
      "claude-3.5-haiku",
      "claude-3.5-sonnet-v2",
      "claude-3-opus-20240229",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "Claude-3.7",
      "CLAUDE-3"
    ];
    
    console.log("Model Name Normalization Results:");
    console.log("--------------------------------");
    for (const model of testModels) {
      console.log(`${model.padEnd(30)} -> ${normalizeModelName(model)}`);
    }
  });
});