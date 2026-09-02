import { extractPhoneNumber } from '@/utils/phone';

test('extracts number from common arg keys', () => {
  expect(extractPhoneNumber({ phoneNumber: '+8613800000000' })).toBe('+8613800000000');
  expect(extractPhoneNumber({ phone_number: '13800000000' })).toBe('13800000000');
  expect(extractPhoneNumber({ phone: '010-12345678' })).toBe('010-12345678');
  expect(extractPhoneNumber({ number: '911' })).toBe('911');
});

test('parses JSON-string args', () => {
  expect(extractPhoneNumber('{"phoneNumber":"13800000000"}')).toBe('13800000000');
});

test('returns null for missing/invalid args', () => {
  expect(extractPhoneNumber(null)).toBeNull();
  expect(extractPhoneNumber({})).toBeNull();
  expect(extractPhoneNumber({ phoneNumber: '  ' })).toBeNull();
  expect(extractPhoneNumber('not-json')).toBeNull();
});
