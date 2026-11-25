import { fixtureBases, fixtureDeletingBases } from "../fixtures";
import OverviewScreen from "../OverviewScreen";

/** The overview with invented bases, for `v2-preview`. */
export default () => <OverviewScreen bases={fixtureBases} deletingBases={fixtureDeletingBases} initialQuery="" />;
