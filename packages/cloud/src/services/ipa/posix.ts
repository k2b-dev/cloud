import { sql } from "bun";

/** Mirror directory-owned attributes, including missing values; never apply local defaults. */
export const mirrorIpaPosix = async (
  db: typeof sql,
  user: {
    userId: string;
    uidNumber: number | null;
    primaryGidNumber: number | null;
    homeDirectory: string | null;
    loginShell: string | null;
  },
): Promise<void> => {
  await db`INSERT INTO auth.user_posix(user_id, managed_by, uid_number, primary_gid_number, home_directory, login_shell)
    VALUES (${user.userId}::uuid, 'ipa', ${user.uidNumber}, ${user.primaryGidNumber}, ${user.homeDirectory}, ${user.loginShell})
    ON CONFLICT(user_id) DO UPDATE SET uid_number = EXCLUDED.uid_number,
      primary_gid_number = EXCLUDED.primary_gid_number, home_directory = EXCLUDED.home_directory, login_shell = EXCLUDED.login_shell
    WHERE auth.user_posix.managed_by = 'ipa'`;
};
