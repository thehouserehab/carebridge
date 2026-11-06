/* Synthetic offline TEST helper only. No operating scanner or file access. */
#include <lcms2.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if LCMS_VERSION != 2190
#error Reviewed LittleCMS 2.19 headers required
#endif
#define PROFILE_LIMIT (1024U * 1024U)
static int color_error = 0;
static void quiet_error(cmsContext context, cmsUInt32Number code, const char *text) {
    (void) context; (void) code; (void) text; color_error = 1;
}
static int write_label(cmsHPROFILE profile, cmsTagSignature tag, const char *text) {
    cmsMLU *label = cmsMLUalloc(NULL, 1);
    if (!label) return 0;
    int ok = cmsMLUsetASCII(label, "en", "US", text) && cmsWriteTag(profile, tag, label);
    cmsMLUfree(label); return ok;
}
static cmsHPROFILE generated(const char *kind) {
    if (strcmp(kind, "srgb") == 0) return cmsCreate_sRGBProfile();
    int parametric = strcmp(kind, "rgb-param1") == 0 ? 2 : strcmp(kind, "rgb-param2") == 0 ? 3 : strcmp(kind, "rgb-param4") == 0 ? 5 : 0;
    if (parametric) {
        /* Public API indexes 1..5 correspond to ICC function numbers 0..4. */
        double values[7] = { 2.2, 1.0, 0, 0.2, 0.1, 0.03, 0.005 };
        if (parametric == 3) { values[1] = 0.9; values[3] = 0.1; }
        cmsToneCurve *curve = cmsBuildParametricToneCurve(NULL, parametric, values);
        if (!curve) return NULL;
        cmsToneCurve *curves[3] = { curve, curve, curve };
        cmsCIExyY white = { 0.3127, 0.3290, 1.0 };
        cmsCIExyYTRIPLE primaries = { { 0.640, 0.330, 1.0 }, { 0.300, 0.600, 1.0 }, { 0.150, 0.060, 1.0 } };
        cmsHPROFILE profile = cmsCreateRGBProfile(&white, &primaries, curves);
        cmsFreeToneCurve(curve); return profile;
    }
    if (strcmp(kind, "p3") == 0) {
        cmsHPROFILE srgb = cmsCreate_sRGBProfile();
        if (!srgb) return NULL;
        cmsToneCurve *curve = cmsReadTag(srgb, cmsSigRedTRCTag);
        cmsToneCurve *curves[3] = { curve, curve, curve };
        cmsCIExyY white = { 0.3127, 0.3290, 1.0 };
        cmsCIExyYTRIPLE primaries = { { 0.680, 0.320, 1.0 }, { 0.265, 0.690, 1.0 }, { 0.150, 0.060, 1.0 } };
        cmsHPROFILE profile = curve ? cmsCreateRGBProfile(&white, &primaries, curves) : NULL;
        cmsCloseProfile(srgb); return profile;
    }
    cmsToneCurve *curve = NULL;
    if (strcmp(kind, "gray-gamma") == 0) curve = cmsBuildGamma(NULL, 2.2);
    else if (strcmp(kind, "gray-table") == 0) {
        cmsUInt16Number values[257];
        for (int index = 0; index < 257; index++) values[index] = (cmsUInt16Number) llround(pow(index / 256.0, 1.8) * 65535.0);
        curve = cmsBuildTabulatedToneCurve16(NULL, 257, values);
    }
    if (!curve) return NULL;
    cmsHPROFILE profile = cmsCreateGrayProfile(cmsD50_xyY(), curve);
    cmsFreeToneCurve(curve); return profile;
}
static int generate(const char *kind, const char *version) {
    cmsHPROFILE profile = generated(kind); if (!profile) return 0;
    if (strcmp(version, "2") == 0) cmsSetProfileVersion(profile, 2.1);
    else if (strcmp(version, "4") == 0) cmsSetProfileVersion(profile, 4.3);
    else { cmsCloseProfile(profile); return 0; }
    cmsSetHeaderManufacturer(profile, 0x54455354U);
    cmsSetHeaderModel(profile, 0x54455354U);
    int ok = write_label(profile, cmsSigProfileDescriptionTag, "SYNTHETIC_PRIVATE_IMAGE_METADATA") &&
        write_label(profile, cmsSigDeviceMfgDescTag, "SYNTHETIC_PRIVATE_IMAGE_METADATA") &&
        write_label(profile, cmsSigDeviceModelDescTag, "SYNTHETIC_PRIVATE_IMAGE_METADATA") &&
        write_label(profile, cmsSigCopyrightTag, "Synthetic test profile legal notice. Preserve verbatim.");
    cmsUInt32Number size = 0;
    ok = ok && cmsSaveProfileToMem(profile, NULL, &size) && size >= 132 && size <= PROFILE_LIMIT;
    void *bytes = ok ? malloc(size) : NULL;
    ok = ok && bytes && cmsSaveProfileToMem(profile, bytes, &size) && !color_error;
    if (ok) ok = fwrite(bytes, 1, size, stdout) == size;
    free(bytes); cmsCloseProfile(profile); return ok;
}
static cmsHPROFILE read_profile(void) {
    unsigned char frame[4]; if (fread(frame, 1, 4, stdin) != 4) return NULL;
    uint32_t size = (uint32_t) frame[0] << 24 | (uint32_t) frame[1] << 16 | (uint32_t) frame[2] << 8 | frame[3];
    if (size < 132 || size > PROFILE_LIMIT) return NULL;
    void *bytes = malloc(size); if (!bytes) return NULL;
    cmsHPROFILE profile = fread(bytes, 1, size, stdin) == size ? cmsOpenProfileFromMem(bytes, size) : NULL;
    free(bytes); return profile;
}
static int transform_pair(cmsHPROFILE source, cmsHPROFILE clean, cmsHPROFILE xyz, int reverse, cmsUInt32Number intent, cmsUInt32Number flags) {
    int gray = cmsGetColorSpace(source) == cmsSigGrayData;
    cmsUInt32Number profile_format = gray ? TYPE_GRAY_DBL : TYPE_RGB_DBL;
    cmsUInt32Number input_format = reverse ? TYPE_XYZ_DBL : profile_format;
    cmsUInt32Number output_format = reverse ? profile_format : TYPE_XYZ_DBL;
    cmsHTRANSFORM before = cmsCreateTransform(reverse ? xyz : source, input_format, reverse ? source : xyz, output_format, intent, flags);
    cmsHTRANSFORM after = cmsCreateTransform(reverse ? xyz : clean, input_format, reverse ? clean : xyz, output_format, intent, flags);
    if (!before || !after) { if (before) cmsDeleteTransform(before); if (after) cmsDeleteTransform(after); puts("ICC_CMM_TRANSFORM_FAILED"); return 0; }
    int count = !reverse && gray ? 257 : 729, channels = reverse && gray ? 1 : 3, ok = 1;
    for (int index = 0; index < count && ok; index++) {
        double input[3],left[3] = { 0 },right[3] = { 0 };
        if (!reverse && gray) input[0] = index / 256.0;
        else { input[0] = (index % 9) / 8.0; input[1] = ((index / 9) % 9) / 8.0; input[2] = (index / 81) / 8.0; }
        cmsDoTransform(before, input, left, 1); cmsDoTransform(after, input, right, 1);
        for (int channel = 0; channel < channels; channel++) if (!isfinite(left[channel]) || !isfinite(right[channel]) || fabs(left[channel] - right[channel]) > 1e-12) ok = 0;
    }
    if (!ok) puts("ICC_CMM_MISMATCH");
    if (color_error) puts("ICC_CMM_ENGINE_ERROR");
    cmsDeleteTransform(before); cmsDeleteTransform(after); return ok && !color_error;
}
static int compare(void) {
    cmsHPROFILE source = read_profile(),clean = read_profile(),xyz = cmsCreateXYZProfile();
    int ok = source && clean && xyz && getchar() == EOF && !ferror(stdin) &&
        cmsGetColorSpace(source) == cmsGetColorSpace(clean) &&
        (cmsGetColorSpace(source) == cmsSigRgbData || cmsGetColorSpace(source) == cmsSigGrayData);
    if (!ok) puts("ICC_CMM_OPEN_FAILED");
    const cmsUInt32Number modes[4] = { 0, cmsFLAGS_NOOPTIMIZE, cmsFLAGS_BLACKPOINTCOMPENSATION, cmsFLAGS_BLACKPOINTCOMPENSATION | cmsFLAGS_NOOPTIMIZE };
    for (cmsUInt32Number intent = 0; intent < 4 && ok; intent++) for (int mode = 0; mode < 4 && ok; mode++) {
        ok = transform_pair(source, clean, xyz, 0, intent, modes[mode]) && transform_pair(source, clean, xyz, 1, intent, modes[mode]);
    }
    if (source) cmsCloseProfile(source);
    if (clean) cmsCloseProfile(clean);
    if (xyz) cmsCloseProfile(xyz);
    if (ok && !color_error) puts("ICC_CMM_OK");
    return ok && !color_error;
}
int main(int argc, char **argv) {
    cmsSetLogErrorHandler(quiet_error);
    if (cmsGetEncodedCMMversion() != 2190) return 2;
    if (argc == 4 && strcmp(argv[1], "generate") == 0) return generate(argv[2], argv[3]) ? 0 : 1;
    if (argc == 2 && strcmp(argv[1], "compare") == 0) return compare() ? 0 : 1;
    return 2;
}
