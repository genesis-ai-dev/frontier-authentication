import * as assert from "assert";
import {
    compareVersions,
} from "../../../utils/extensionVersionChecker";

suite("Unit: Version Comparison", () => {
    test("compareVersions ignores prerelease affixes for required version checks", () => {
        assert.strictEqual(compareVersions("0.24.1", "0.24.1-pr123"), 0);
        assert.strictEqual(compareVersions("0.24.1-pr122", "0.24.1-pr123"), 0);
        assert.strictEqual(compareVersions("0.24.2-pr1", "0.24.1"), 1);
        assert.strictEqual(compareVersions("0.24.1-pr5-abc1234", "0.24.1"), 0);
        assert.strictEqual(compareVersions("0.24.1-pr5-abc1234", "0.24.2"), -1);
    });
});
