import { backupProfile, restoreProfile } from "./profile-backup";
import { runLocalOpenBot } from "./server";

const [command, operation, source, destination, ...extra] =
  process.argv.slice(2);
if (command === "profile") {
  if (
    (operation !== "backup" && operation !== "restore") ||
    !source ||
    !destination ||
    extra.length
  ) {
    console.error(
      "Usage: OpenBotLocal.exe profile backup|restore <source> <new-destination>",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await (operation === "backup"
        ? backupProfile
        : restoreProfile)(source, destination);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
} else if (!command) {
  runLocalOpenBot();
} else {
  console.error(
    "Usage: OpenBotLocal.exe [profile backup|restore <source> <new-destination>]",
  );
  process.exitCode = 2;
}
