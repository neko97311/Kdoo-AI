import * as ImagePicker from 'expo-image-picker';
import {
  pickMultipleImagesFromGallery,
  pickImageFromGallery,
} from '../attachments';

/**
 * expo-image-picker is mocked explicitly with controllable fns so we can drive
 * the permission + launch results deterministically. (The jest-expo preset
 * already auto-mocks it, but we need precise return values per test.)
 */
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

const assetA = {
  uri: 'file://a.jpg',
  mimeType: 'image/jpeg',
  fileName: 'a.jpg',
  fileSize: 123,
};
const assetB = {
  uri: 'file://b.png',
  mimeType: 'image/png',
  fileName: 'b.png',
  fileSize: 456,
};
// Minimal asset exercising every defaulting branch in imageAssetToAttachment.
const assetMinimal = { uri: 'file://c.jpg' };

const granted = { status: 'granted' };
const denied = { status: 'denied' };

const permMock = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const launchMock = ImagePicker.launchImageLibraryAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  permMock.mockResolvedValue(granted);
});

describe('pickMultipleImagesFromGallery', () => {
  it('returns an Attachment per picked asset with passthrough + derived fields', async () => {
    launchMock.mockResolvedValue({ canceled: false, assets: [assetA, assetB] });

    const result = await pickMultipleImagesFromGallery();

    expect(result).toHaveLength(2);
    // assetA — all fields supplied by the asset
    expect(result[0].uri).toBe('file://a.jpg');
    expect(result[0].type).toBe('image');
    expect(result[0].mediaType).toBe('image/jpeg');
    expect(result[0].name).toBe('a.jpg');
    expect(result[0].size).toBe(123);
    expect(result[0].id).toMatch(/^img_\d+_/);
    // assetB
    expect(result[1].uri).toBe('file://b.png');
    expect(result[1].mediaType).toBe('image/png');
    expect(result[1].name).toBe('b.png');
    expect(result[1].size).toBe(456);
    expect(result[1].id).toMatch(/^img_\d+_/);
  });

  it('defaults missing mimeType/fileName/fileSize (image/jpeg, generated name, undefined size)', async () => {
    launchMock.mockResolvedValue({ canceled: false, assets: [assetMinimal] });

    const result = await pickMultipleImagesFromGallery();

    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe('image/jpeg');
    // name generated as image_<ts>.<ext>; ext comes from mediaType split ('jpeg')
    expect(result[0].name).toMatch(/^image_\d+\.\w+$/);
    expect(result[0].size).toBeUndefined();
    expect(result[0].type).toBe('image');
    expect(result[0].uri).toBe('file://c.jpg');
  });

  it('returns [] and does NOT launch the picker when permission is denied', async () => {
    permMock.mockResolvedValue(denied);

    const result = await pickMultipleImagesFromGallery();

    expect(result).toEqual([]);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('returns [] when the user cancels (canceled: true)', async () => {
    launchMock.mockResolvedValue({ canceled: true, assets: [] });

    expect(await pickMultipleImagesFromGallery()).toEqual([]);
  });

  it('returns [] when assets come back empty', async () => {
    launchMock.mockResolvedValue({ canceled: false, assets: [] });

    expect(await pickMultipleImagesFromGallery()).toEqual([]);
  });

  it('uses allowsMultipleSelection and shares mediaTypes+quality with pickImageFromGallery', async () => {
    launchMock.mockResolvedValue({ canceled: false, assets: [assetA] });

    // Drive both pickers under the same mock; order of calls is deterministic.
    await pickImageFromGallery(); // single pick first
    await pickMultipleImagesFromGallery(); // multi pick second

    const calls = launchMock.mock.calls;
    const singleOpts = calls[0][0];
    const multiOpts = calls[1][0];

    expect(multiOpts.allowsMultipleSelection).toBe(true);
    expect(multiOpts.mediaTypes).toEqual(singleOpts.mediaTypes);
    expect(multiOpts.quality).toEqual(singleOpts.quality);
  });
});
