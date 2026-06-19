// src/lib/stringUtils.js

export function normalizeForComparison(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function calculateStringSimilarity(str1, str2) {
    const s1 = (str1 || "").toLowerCase();
    const s2 = (str2 || "").toLowerCase();
    const len1 = s1.length;
    const len2 = s2.length;
    const maxLen = Math.max(len1, len2);
    if (maxLen === 0) return 1.0;

    const dp = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
    for (let i = 0; i <= len1; i++) dp[i][0] = i;
    for (let j = 0; j <= len2; j++) dp[0][j] = j;

    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return 1 - (dp[len1][len2] / maxLen);
}

// Rejects candidate if it exactly matches, is contained within, or has
// Levenshtein similarity > 0.75 against any entry in excludedList.
export function isTextTooSimilar(candidate, excludedList) {
    if (!candidate || !excludedList || excludedList.length === 0) return false;
    const newNorm = normalizeForComparison(candidate);
    if (!newNorm) return false;

    for (const excluded of excludedList) {
        const exNorm = normalizeForComparison(excluded);
        if (!exNorm) continue;

        // 1. Exact match
        if (newNorm === exNorm) return true;

        // 2. Containment: one text is a substring of the other
        //    e.g. "wilbur" contained in "orville and wilbur"
        if (newNorm.length >= 3 && exNorm.length >= 3) {
            if (newNorm.includes(exNorm) || exNorm.includes(newNorm)) {
                return true;
            }
        }

        // 3. High string similarity (Levenshtein)
        const similarity = calculateStringSimilarity(newNorm, exNorm);
        if (similarity > 0.75) return true;
    }

    return false;
}
