import { join } from "node:path";

const developmentProcessorProfile = "debug";
const releaseProcessorProfile = "release";

export function resolveLocalProcessorExecutable(
  rootDirectory: string,
  isPackaged: boolean,
  executableName: string,
): string {
  const profile = isPackaged ? releaseProcessorProfile : developmentProcessorProfile;
  return join(rootDirectory, "processor-rust", "target", profile, executableName);
}
