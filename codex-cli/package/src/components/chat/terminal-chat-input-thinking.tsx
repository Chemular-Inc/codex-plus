import { log, isLoggingEnabled } from "../../utils/agent/log.js";
import { Box, Text, useInput, useStdin } from "ink";
import React, { useState } from "react";
import { useInterval } from "use-interval";
import chalk from "chalk";

// Retaining a single static placeholder text for potential future use.  The
// more elaborate randomised thinking prompts were removed to streamline the
// UI – the elapsed‑time counter now provides sufficient feedback.

// Function to get current token count from the rate limiter
function getCurrentTokenCount(): number {
  try {
    // Import the rate limiter dynamically to avoid circular dependencies
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rateLimiter = require("../../utils/rate-limiter.js").globalRateLimiter;
    
    // Try Anthropic first, then OpenAI if no Anthropic data
    const providers = ["anthropic", "openai"];
    
    for (const provider of providers) {
      // Access the internal usageTrackers map to get token count
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tracker = (rateLimiter as any).usageTrackers?.get(provider);
      if (tracker && typeof tracker.tokenCount === 'number') {
        return tracker.tokenCount;
      }
    }
  } catch (e) {
    // Silently fail if there's an error
    if (isLoggingEnabled()) {
      log(`Error getting token count: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  return 0;
}

export default function TerminalChatInputThinking({
  onInterrupt,
  active,
  thinkingSeconds,
}: {
  onInterrupt: () => void;
  active: boolean;
  thinkingSeconds: number;
}): React.ReactElement {
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [dots, setDots] = useState("");

  // Update token count periodically
  useInterval(() => {
    if (active) {
      setTokenCount(getCurrentTokenCount());
    }
  }, 1000);

  // Animate the ellipsis
  useInterval(() => {
    setDots((prev) => (prev.length < 3 ? prev + "." : ""));
  }, 500);

  const { stdin, setRawMode } = useStdin();

  React.useEffect(() => {
    if (!active) {
      return;
    }

    setRawMode?.(true);

    const onData = (data: Buffer | string) => {
      if (awaitingConfirm) {
        return;
      }

      const str = Buffer.isBuffer(data) ? data.toString("utf8") : data;
      if (str === "\x1b\x1b") {
        if (isLoggingEnabled()) {
          log(
            "raw stdin: received collapsed ESC ESC – starting confirmation timer",
          );
        }
        setAwaitingConfirm(true);
        setTimeout(() => setAwaitingConfirm(false), 1500);
      }
    };

    stdin?.on("data", onData);
    return () => {
      stdin?.off("data", onData);
    };
  }, [stdin, awaitingConfirm, onInterrupt, active, setRawMode]);

  // No timers required beyond tracking the elapsed seconds supplied via props.

  useInput(
    (_input, key) => {
      if (!key.escape) {
        return;
      }

      if (awaitingConfirm) {
        if (isLoggingEnabled()) {
          log("useInput: second ESC detected – triggering onInterrupt()");
        }
        onInterrupt();
        setAwaitingConfirm(false);
      } else {
        if (isLoggingEnabled()) {
          log("useInput: first ESC detected – waiting for confirmation");
        }
        setAwaitingConfirm(true);
        setTimeout(() => setAwaitingConfirm(false), 1500);
      }
    },
    { isActive: active },
  );

  // Elegant animation frames for a more premium look
  const spinnerFrames = [
    "◜", "◠", "◝", "◞", "◡", "◟"
  ];

  const [frame, setFrame] = useState(0);

  useInterval(() => {
    setFrame((idx) => (idx + 1) % spinnerFrames.length);
  }, 100);

  // Format token count with commas for better readability
  const formattedTokenCount = tokenCount.toLocaleString();
  
  // Calculate percentage of context window used (assuming a typical 100k token window)
  const contextSize = 100000;
  const percentUsed = Math.min(100, Math.ceil((tokenCount / contextSize) * 100));
  
  // Create a gradient color based on token usage
  const getTokenColor = () => {
    if (percentUsed < 50) return chalk.green;
    if (percentUsed < 80) return chalk.yellow;
    return chalk.red;
  };
  
  const tokenColor = getTokenColor();
  
  // Generate progress bar
  const progressBarLength = 10;
  const filledBars = Math.max(1, Math.floor((percentUsed / 100) * progressBarLength));
  const emptyBars = progressBarLength - filledBars;
  
  const progressBar = 
    chalk.bgGray(chalk.white("┃")) + 
    tokenColor(chalk.bgBlack("█".repeat(filledBars))) + 
    chalk.bgBlack("░".repeat(emptyBars)) + 
    chalk.bgGray(chalk.white("┃"));

  // Current spinner frame
  const spinnerChar = spinnerFrames[frame];
  
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} flexDirection="column">
        <Box>
          <Text>
            {chalk.cyan(`${spinnerChar} `)}
            <Text bold color="magenta">Thinking{dots}</Text>
            {chalk.dim(` • ${thinkingSeconds}s elapsed`)}
          </Text>
        </Box>
        
        <Box>
          <Text>
            {chalk.cyan("⟨")}
            <Text bold>{chalk.white(`Tokens: ${formattedTokenCount}`)}</Text>
            {chalk.cyan("⟩")}
            {` ${progressBar} `}
            <Text dimColor>{`${percentUsed}%`}</Text>
          </Text>
        </Box>
      </Box>
      
      {awaitingConfirm && (
        <Text dimColor>
          Press <Text bold>Esc</Text> again to interrupt and enter a new instruction
        </Text>
      )}
    </Box>
  );
}
