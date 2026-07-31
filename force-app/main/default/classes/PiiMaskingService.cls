/*
 * PiiMaskingService.cls
 *
 * Masks personally identifiable information before text is sent to an LLM, and
 * restores it in the response.
 *
 * The restore half is what makes this usable. Masking alone produces an agent
 * that answers "Please contact [PERSON_1] at [EMAIL_1]", which is safe and
 * useless. Holding the mapping in memory for the duration of the request lets
 * the user see real values while the model never does.
 *
 * Demonstrates: PII handling, data governance, audit trail, compliance in a
 * regulated industry.
 */
public with sharing class PiiMaskingService {

    public class MaskResult {
        public String maskedText;
        public Map<String, String> tokenToOriginal;
        public Integer maskedCount { get { return tokenToOriginal.size(); } }
    }

    // Ordering matters: email must run before phone, or the digits inside an
    // address like a1234@x.com get partially eaten by the phone pattern.
    private static final List<Pattern> PATTERNS = new List<Pattern>{
        Pattern.compile('(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}'),
        Pattern.compile('\\b(?:\\+?1[-. ]?)?\\(?\\d{3}\\)?[-. ]\\d{3}[-. ]\\d{4}\\b'),
        Pattern.compile('\\b\\d{3}-\\d{2}-\\d{4}\\b'),
        Pattern.compile('\\b[A-Z]{2}\\d{6,9}\\b')
    };

    private static final List<String> LABELS = new List<String>{
        'EMAIL', 'PHONE', 'SSN', 'HEALTHCARD'
    };

    /**
     * Replaces each PII match with a stable token. The same value appearing
     * twice gets the same token, so the model can still reason about "the same
     * person" without ever seeing who it is.
     */
    public static MaskResult mask(String input) {
        MaskResult result = new MaskResult();
        result.tokenToOriginal = new Map<String, String>();

        if (String.isBlank(input)) {
            result.maskedText = input;
            return result;
        }

        String working = input;
        Map<String, String> originalToToken = new Map<String, String>();

        for (Integer i = 0; i < PATTERNS.size(); i++) {
            Matcher m = PATTERNS[i].matcher(working);
            Integer counter = 1;
            List<String> rebuilt = new List<String>();
            Integer last = 0;

            while (m.find()) {
                String found = m.group();
                String token = originalToToken.get(found);
                if (token == null) {
                    token = '[' + LABELS[i] + '_' + counter + ']';
                    counter++;
                    originalToToken.put(found, token);
                    result.tokenToOriginal.put(token, found);
                }
                rebuilt.add(working.substring(last, m.start()));
                rebuilt.add(token);
                last = m.end();
            }
            rebuilt.add(working.substring(last));
            working = String.join(rebuilt, '');
        }

        result.maskedText = working;
        return result;
    }

    /**
     * Restores original values in an LLM response. Only tokens issued during
     * this request are restored — a model that hallucinates [EMAIL_9] gets
     * nothing back rather than someone else's address.
     */
    public static String unmask(String modelOutput, Map<String, String> tokenToOriginal) {
        if (String.isBlank(modelOutput) || tokenToOriginal == null) {
            return modelOutput;
        }
        String restored = modelOutput;
        for (String token : tokenToOriginal.keySet()) {
            restored = restored.replace(token, tokenToOriginal.get(token));
        }
        return restored;
    }
}
