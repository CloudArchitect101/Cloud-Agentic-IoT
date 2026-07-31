@IsTest
private class PiiMaskingServiceTest {

    @IsTest
    static void masksEmailPhoneAndSsn() {
        String input = 'Contact jane.doe@example.com or 604-555-0134. SSN 123-45-6789.';
        PiiMaskingService.MaskResult r = PiiMaskingService.mask(input);

        Assert.isFalse(r.maskedText.contains('jane.doe@example.com'), 'Email must be masked');
        Assert.isFalse(r.maskedText.contains('604-555-0134'), 'Phone must be masked');
        Assert.isFalse(r.maskedText.contains('123-45-6789'), 'SSN must be masked');
        Assert.areEqual(3, r.maskedCount, 'Three distinct values masked');
    }

    @IsTest
    static void repeatedValueGetsTheSameToken() {
        String input = 'Email a@b.com now, then follow up at a@b.com tomorrow.';
        PiiMaskingService.MaskResult r = PiiMaskingService.mask(input);

        Assert.areEqual(1, r.maskedCount, 'The same address must map to one token');
        Assert.isTrue(r.maskedText.indexOf('[EMAIL_1]') != r.maskedText.lastIndexOf('[EMAIL_1]'),
            'Both occurrences replaced with the same token so the model can still corefer');
    }

    @IsTest
    static void roundTripRestoresOriginalValues() {
        String input = 'Reach jane.doe@example.com on 604-555-0134.';
        PiiMaskingService.MaskResult r = PiiMaskingService.mask(input);
        String modelReply = 'I will contact ' + r.maskedText;

        String restored = PiiMaskingService.unmask(modelReply, r.tokenToOriginal);

        Assert.isTrue(restored.contains('jane.doe@example.com'), 'Email restored for the user');
        Assert.isTrue(restored.contains('604-555-0134'), 'Phone restored for the user');
    }

    @IsTest
    static void hallucinatedTokenIsNotRestored() {
        PiiMaskingService.MaskResult r = PiiMaskingService.mask('Contact a@b.com');
        String reply = 'Also try [EMAIL_9] and [SSN_3].';

        String restored = PiiMaskingService.unmask(reply, r.tokenToOriginal);

        Assert.isTrue(restored.contains('[EMAIL_9]'),
            'A token never issued must stay unresolved rather than leaking another value');
    }

    @IsTest
    static void handlesBlankAndNullSafely() {
        Assert.areEqual(null, PiiMaskingService.mask(null).maskedText, 'null in, null out');
        Assert.areEqual('', PiiMaskingService.mask('').maskedText, 'blank is untouched');
        Assert.areEqual('x', PiiMaskingService.unmask('x', null), 'null map returns input unchanged');
    }

    @IsTest
    static void textWithNoPiiIsUnchanged() {
        String input = 'Device ESP32-01 reported 21.4 degrees.';
        PiiMaskingService.MaskResult r = PiiMaskingService.mask(input);
        Assert.areEqual(input, r.maskedText, 'Non-PII text must pass through untouched');
        Assert.areEqual(0, r.maskedCount, 'Nothing masked');
    }
}
