import OverviewScreen from "../OverviewScreen";
import { fixtureBases, fixtureDeletingBases } from "../fixtures";

/** The overview with invented bases, for `v2-preview`. */
export default () => <OverviewScreen bases={fixtureBases} deletingBases={fixtureDeletingBases} initialQuery="" />;
