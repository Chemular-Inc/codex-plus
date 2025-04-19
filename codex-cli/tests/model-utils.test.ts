import { describe, it, expect, vi } from "vitest";
import { normalizeModelName, CLAUDE_MODEL_MAP } from "../src/utils/model-utils";

describe("Model Utilities", () => {
  describe("normalizeModelName", () => {
    it("should normalize Claude model names with dots to their full API versions", () => {
      expect(normalizeModelName("claude-3.5")).toBe("claude-3-5-sonnet-20241022");
      expect(normalizeModelName("claude-3.7")).toBe("claude-3-7-sonnet-20250219");
    });

    it("should map short Claude model names to their full versions with date identifiers", () => {
      expect(normalizeModelName("claude-3")).toBe("claude-3-opus-20240229");
      expect(normalizeModelName("claude-3-5")).toBe("claude-3-5-sonnet-20241022");
      expect(normalizeModelName("claude-3-7")).toBe("claude-3-7-sonnet-20250219");
    });

    it("should map architecture-only Claude model names to their full versions", () => {
      expect(normalizeModelName("claude-3-opus")).toBe("claude-3-opus-20240229");
      expect(normalizeModelName("claude-3-sonnet")).toBe("claude-3-sonnet-20240229");
      expect(normalizeModelName("claude-3-haiku")).toBe("claude-3-haiku-20240307");
      expect(normalizeModelName("claude-3-5-haiku")).toBe("claude-3-5-haiku-20241022");
    });

    it("should handle named variants and version specifiers", () => {
      expect(normalizeModelName("claude-3.5-sonnet-v2")).toBe("claude-3-5-sonnet-20241022");
      expect(normalizeModelName("claude-3.5-haiku")).toBe("claude-3-5-haiku-20241022");
    });

    it("should preserve already full Claude model names", () => {
      expect(normalizeModelName("claude-3-opus-20240229")).toBe("claude-3-opus-20240229");
      expect(normalizeModelName("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet-20241022");
      expect(normalizeModelName("claude-3-7-sonnet-20250219")).toBe("claude-3-7-sonnet-20250219");
    });

    it("should handle case insensitivity for Claude models", () => {
      expect(normalizeModelName("Claude-3.7")).toBe("claude-3-7-sonnet-20250219");
      expect(normalizeModelName("CLAUDE-3")).toBe("claude-3-opus-20240229");
      expect(normalizeModelName("Claude-3.5-Haiku")).toBe("claude-3-5-haiku-20241022");
    });

    it("should pass through non-Claude model names", () => {
      expect(normalizeModelName("gpt-4")).toBe("gpt-4");
      expect(normalizeModelName("o4-mini")).toBe("o4-mini");
    });

    it("should handle undefined or empty input", () => {
      expect(normalizeModelName("")).toBe("");
      expect(normalizeModelName(undefined as any)).toBe(undefined);
    });
  });

  describe("CLAUDE_MODEL_MAP", () => {
    it("should contain mappings for all Claude model variants", () => {
      // Check that common model names are in the map
      expect(CLAUDE_MODEL_MAP["claude-3"]).toBeDefined();
      expect(CLAUDE_MODEL_MAP["claude-3.5"]).toBeDefined();
      expect(CLAUDE_MODEL_MAP["claude-3.7"]).toBeDefined();
      
      // Check new models
      expect(CLAUDE_MODEL_MAP["claude-3.5-haiku"]).toBeDefined();
      expect(CLAUDE_MODEL_MAP["claude-3.5-sonnet-v2"]).toBeDefined();
      expect(CLAUDE_MODEL_MAP["claude-3-5-haiku"]).toBeDefined();
      
      // Check that full model names map to themselves
      expect(CLAUDE_MODEL_MAP["claude-3-opus-20240229"]).toBe("claude-3-opus-20240229");
      expect(CLAUDE_MODEL_MAP["claude-3-5-haiku-20241022"]).toBe("claude-3-5-haiku-20241022");
    });
  });
});