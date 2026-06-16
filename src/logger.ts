export type Logger = (message: string) => void;

export function createLogger(verbose: boolean): Logger {
  return (message: string) => {
    if (!verbose && message.startsWith("[debug]")) return;
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`[${timestamp}] ${message}`);
  };
}
