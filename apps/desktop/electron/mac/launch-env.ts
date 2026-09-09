/**
 * The environment a USER'S OWN APP must be launched into.
 *
 * A launched app inherits this process's environment, and this process does not
 * always have the user's. MEASURED, and it reached the user's screen: a probe gave
 * Bobble a throwaway HOME for isolation, the model asked for Chrome, and Chrome
 * inherited it — coming up with no profile and no keychain. He got the profile
 * picker ("Who's using Chrome?") and "A keychain cannot be found to store
 * Chrome", and the run spent itself driving a blank Chrome that was not his.
 *
 * It is a product bug, not a probe bug: whatever HOME this process is carrying —
 * a test harness's, a sandbox's, a scheduled run's — an app the user asked for
 * has to open as THEIR app, with their profile, their logins and their history.
 */
import { userInfo } from 'node:os';

/**
 * `process.env` with HOME forced to the user's real home.
 *
 * `os.userInfo()` reads the password database rather than $HOME, so it is right
 * even when $HOME is a lie. Nothing else is filtered — an app the user asked for
 * should open exactly as it opens for them.
 */
export function userLaunchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  try {
    return { ...env, HOME: userInfo().homedir };
  } catch {
    return { ...env };
  }
}
