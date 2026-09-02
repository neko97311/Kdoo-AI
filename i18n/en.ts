export default {
  // Common
  common: {
    cancel: 'Cancel',
    delete: 'Delete',
    sessionExpired: 'Session expired. Please sign in again.',
    networkError: 'Network connection failed. Please check your network.',
    operationFailed: 'Operation failed. Please try again.',
  },

  // App
  app: {
    title: 'KDOO AI',
    starting: 'Starting app...',
    loading: 'Loading...',
  },

  // 404
  notFound: {
    title: 'Page not found',
    message: "The page you're looking for doesn't exist.",
    goHome: 'Go back home',
  },

  // Auth - Login
  login: {
    welcome: 'Welcome back',
    subtitle: 'Sign in to your account to continue',
    email: 'Email',
    emailPlaceholder: 'your@email.com',
    password: 'Password',
    forgotPassword: 'Forgot password?',
    signIn: 'Sign In',
    signingIn: 'Signing in...',
    orSignInWith: 'Or sign in with',
    noAccount: "Don't have an account? ",
    createAccount: 'Create account',
    loginFailed: 'Login Failed',
    loginFailedMsg: 'Please check your credentials and try again.',
    errorEmailRequired: 'Please enter your email',
    errorPasswordRequired: 'Please enter your password',
    errorPasswordShort: 'Password must be at least 6 characters',
    errorPasswordLong: 'Password cannot exceed 50 characters',
    errorInvalidEmail: 'Invalid email format',
    googleFailed: 'Google Sign-In Failed',
    appleFailed: 'Apple Sign-In Failed',
    tryAgain: 'Please try again.',
  },

  // Auth - Signup
  // Auth - Register
  register: {
    // Step 1 — Send verification code
    title: 'Create Account',
    subtitle: 'Enter your email address and we\'ll send you a verification code',
    email: 'Email',
    emailPlaceholder: 'your@email.com',
    sendCode: 'Send Code',
    sending: 'Sending...',
    backToLogin: 'Back to Login',
    errorSend: 'Failed to send verification code. Please try again.',
    errorEmailRequired: 'Please enter your email address.',

    // Step 2 — Verify code
    enterCode: 'Enter verification code',
    codeSentTo: 'A verification code has been sent to ',
    verifyCode: 'Verify',
    verifying: 'Verifying...',
    resendCode: 'Resend',
    resendIn: 'Resend in {{seconds}}s',
    errorCodeIncomplete: 'Please enter the complete 6-digit verification code.',
    errorCodeVerify: 'Verification code is incorrect or expired. Please try again.',

    // Step 3 — Set password & register
    setPassword: 'Set password',
    setPasswordHint: 'Enter your password to create your account',
    password: 'Password',
    passwordPlaceholder: 'At least 6 characters',
    register: 'Create Account',
    registering: 'Creating account...',
    errorPasswordRequired: 'Please enter a password.',
    errorPasswordShort: 'Password must be at least 6 characters.',
    errorPasswordMismatch: 'Passwords do not match.',
    errorRegister: 'Registration failed. Please try again.',
    passwordHint: 'Password must be at least 6 characters',
    confirmPassword: 'Confirm password',
    confirmPasswordPlaceholder: 'Re-enter password',
    successTitle: 'Account Created',
    successMessage: 'Your account has been created successfully. Welcome to KDOO AI!',
  },

  // Auth - Forgot Password
  forgotPassword: {
    title: 'Forgot password?',
    subtitle: 'Enter your email address and we\'ll send you a verification code',
    email: 'Email',
    emailPlaceholder: 'your@email.com',
    sendCode: 'Send Code',
    sending: 'Sending...',
    backToSignIn: 'Back to Sign In',
    checkEmail: 'Check your email',
    sentTo: "We've sent a password reset link to ",
    errorSend: 'Failed to send verification code. Please try again.',
    errorEmailRequired: 'Please enter your email address.',
    errorInvalidEmail: 'Invalid email format.',

    // Step 2 — Verify code
    enterCode: 'Enter verification code',
    codeSentTo: 'A verification code has been sent to ',
    verifyCode: 'Verify',
    verifying: 'Verifying...',
    resendCode: 'Resend',
    resendIn: 'Resend in {{seconds}}s',
    errorCodeIncomplete: 'Please enter the complete 6-digit verification code.',
    errorCodeVerify: 'Verification code is incorrect or expired. Please try again.',

    // Step 3 — Reset password
    setNewPassword: 'Set new password',
    setNewPasswordHint: 'Enter your new password',
    newPassword: 'New password',
    newPasswordPlaceholder: 'At least 6 characters',
    confirmPassword: 'Confirm password',
    confirmPasswordPlaceholder: 'Re-enter new password',
    passwordHint: 'Password must be at least 6 characters',
    resetPassword: 'Reset Password',
    resetting: 'Resetting...',
    errorPasswordRequired: 'Please enter a new password.',
    errorPasswordShort: 'Password must be at least 6 characters.',
    errorPasswordLong: 'Password cannot exceed 50 characters.',
    errorPasswordMismatch: 'Passwords do not match.',
    errorReset: 'Failed to reset password. Please try again.',
    successTitle: 'Password Reset',
    successMessage: 'Your password has been changed successfully. Please sign in with your new password.',
    autoRedirect: 'Returning to sign in in',
  },

  // Chat Home
  chatHome: {
    greeting: 'Hello,',
    howCanIHelp: 'how can I help you?',
    actionTripRio: 'Plan a 3-day trip to Rio de Janeiro',
    actionAstronautDog: 'Create an image of an astronaut dog',
    sending: 'Sending...',
  },

  // Chat Input
  chatInput: {
    placeholder: 'Type your message...',
    creating: 'Creating session...',
    images: 'Images',
    camera: 'Camera',
    files: 'Files',
    listening: 'Listening...',
    holdToSpeak: 'Hold to Speak',
    messagePlaceholder: 'Message...',
    messagePlaceholderHold: 'Type or hold to speak...',
    location: 'Location',
    voiceCall: 'Voice Call',
    uploadFailed: 'Failed to process attachment',
  },

  // Photo compose screen (caption photos after capture/pick, then send)
  photoCompose: {
    cancel: 'Cancel',
    title: 'Edit Photo',
    addCamera: 'Add Photo',
    addGallery: 'Add from Gallery',
    placeholder: 'Say something...',
    placeholderView: 'Send this image...',
  },

  // Camera screen (in-app viewfinder)
  cameraScreen: {
    cancel: 'Cancel',
    permissionTitle: 'Camera access is needed to take photos',
    enableCamera: 'Enable Camera',
    deniedTitle: 'Camera access is off',
    deniedHint: 'Turn on camera permission in system settings',
    back: 'Back',
  },

  // Voice Call
  voiceCall: {
    connecting: 'Connecting...',
    listening: 'Listening...',
    thinking: 'Thinking...',
    speaking: 'Speaking...',
    ready: 'You can start speaking',
    ended: 'Call ended',
    error: 'Connection failed, please try again',
    poorConnection: 'Poor connection, reconnecting...',
    noNetwork: 'Poor network, unable to connect',
    serverUnreachable: 'Service unavailable, reconnecting...',
    contentByAI: 'Content generated by AI',
    reconnecting: 'Reconnecting...',
    transcriptToggle: 'Transcript',
    transcriptError: 'Failed to save transcript',
    sessionCreateFailed: 'Failed to start voice call',
    sessionName: 'Voice Call {{ts}}',
    micToggle: 'Microphone',
    screenShare: 'Share screen',
    camera: 'Camera',
    hangup: 'End call',
  },

  // Chat Drawer
  chatDrawer: {
    searchChats: 'Search chats',
    newChat: 'New chat',
    loadingChats: 'Loading chats...',
    noConversations: 'No conversations yet',
    pinned: 'Pinned',
    recent: 'Recent',
    justNow: 'Just now',
    minutesAgo: 'm ago',
    hoursAgo: 'h ago',
    yesterday: 'Yesterday',
    daysAgo: 'd ago',
    settings: 'Settings',
    unpin: 'Unpin',
    cancel: 'Cancel',
    confirm: 'Confirm',
    pin: 'Pin',
    rename: 'Rename',
    renamePlaceholder: 'Enter new name',
    share: 'Share',
    shareFailed: 'Failed to share. Please try again.',
    delete: 'Delete',
    deleteConfirmTitle: 'Delete chat',
    deleteConfirmMessage: 'Are you sure you want to delete this chat?',
  },

  // Chat View
  chatView: {
    loadingOlder: 'Loading older messages...',
    sendFailed: 'Message failed to send',
    replyTimeout: 'Response timed out. Reconnecting automatically.',
    sessionNotFound: 'Chat session not found: {{id}}',
  },

  // AI creation completion (video/image)
  chat: {
    message: {
      videoReady: 'Your video is ready',
      videoLoading: 'Video loading...',
      videoLoadFailed: 'Failed to load video',
      videoDownload: 'Download',
      videoSaving: 'Saving...',
      videoDownloaded: 'Video saved to gallery',
      videoDownloadFailed: 'Download failed',
    },
  },

  // Video search results
  video: {
    showMore: 'Show more ({{count}})',
  },

  // Music search results
  music: {
    showMore: 'Show more ({{count}})',
    playbackFailed: 'Playback failed',
  },

  // Image search results
  image: {
    showMore: 'Show more ({{count}})',
  },

  // Search Chats
  searchChats: {
    placeholder: 'Search chats',
    recentConversations: 'Recent Conversations',
    noMatching: 'No matching conversations',
    noConversations: 'No conversations yet',
    today: 'Today',
    yesterday: 'Yesterday',
    daysAgo: ' days ago',
  },

  // Voice Overlay
  voiceOverlay: {
    slideUpToCancel: '↑ Slide up to cancel',
    releaseToCancel: 'Release to cancel',
    noTextRecognized: 'No speech recognized',
  },

  // Code Block
  codeBlock: {
    copy: 'Copy',
    copied: 'Copied!',
  },

  // Button
  button: {
    loading: 'Loading...',
  },

  // Time
  time: {
    justNow: 'Just now',
    today: 'Today',
    minutesAgo: 'm ago',
    hoursAgo: 'h ago',
    yesterday: 'Yesterday',
    daysAgo: 'd ago',
    last7: 'Last 7 days',
    lastMonth: 'Last month',
    older: 'Older',
  },

  // Profile Settings
  profileSettings: {
    title: 'Profile Settings',
    profileActions: 'Profile Actions',
    sectionAccount: 'Account',
    sectionPreferences: 'Preferences',
    sectionAbout: 'About',
    accountSettings: 'Account Settings',
    themeSettings: 'Theme Settings',
    languageSettings: 'Language Settings',
    changePassword: 'Change Password',
    loginMethods: 'Login Methods',
    logOut: 'Log Out',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'Follow System',
    langChinese: 'Chinese',
    langEnglish: 'English',
    langPortuguese: 'Portuguese',
    saving: 'Saving...',
    version: 'KDOO AI {{version}}',
    helloVisitor: 'Hello, Visitor!',
    themeUpdateFailed: 'Failed to update theme',
    languageUpdateFailed: 'Failed to update language',
  },

  voiceSettings: {
    title: 'Voice',
    defaultVoiceTitle: 'Default Voice',
    defaultVoiceHint: 'Pick one voice you like',
    myClonedTitle: 'My Cloned Voices',
    myClonedCount: '{{used}}/{{max}}',
    cloneButton: 'Clone My Voice',
    cloneTitle: 'Clone My Voice',
    clonePrompt: 'Please read the following text (5–30 seconds):',
    cloneSampleText: 'Today is a beautiful day, and I want to share this blessing with you. May every day of yours be filled with sunshine.',
    cloneDefaultName: 'My voice {{suffix}}',
    cloneStart: 'Start Recording',
    cloneStop: 'Stop Recording',
    cloneSubmit: 'Submit',
    cloneConverting: 'Converting…',
    cloneConvertFailed: 'Audio conversion failed, please try again',
    cloneTooShort: 'Recording too short (< 5s)',
    cloneTooLong: 'Auto-stopped (> 30s)',
    clonePermissionDenied: 'Please grant microphone permission',
    cloneSubmitFailed: 'Submit failed, please try again',
    training: 'Training…',
    failed: 'Failed: {{reason}}',
    failedShort: 'Failed',
    deleteConfirmTitle: 'Delete voice?',
    deleteConfirmBody: 'Delete "{{name}}"?',
    previewFailed: 'Preview failed',
    quotaExceeded: 'Cloned voice quota full ({{used}}/{{max}}). Delete one first.',
    loadingVoices: 'Loading voices…',
    emptyMyCloned: 'No cloned voices yet',
    errorLoadVoices: 'Failed to load voices',
    saveFailed: 'Failed to save. Please try again.',
    rename: 'Rename',
    renameTitle: 'Rename voice',
    renamePlaceholder: 'Enter a new name',
    renameConfirm: 'Save',
    renameEmpty: 'Name cannot be empty',
    renameTooLong: 'Name too long (max 60 characters)',
    renameFailed: 'Rename failed, please try again',
    tabMine: 'Mine',
    tabEn: 'English',
    tabZh: 'Chinese',
    tabPt: 'Portuguese',
    emptyGroup: 'No voices in {{group}}',
  },

  voiceClone: {
    title: 'Clone My Voice',
    prompt: 'Please read the text below (5–30 seconds)',
    holdToRecord: 'Hold to Record',
    recording: 'Recording…',
    releaseToSubmit: 'Release to Submit',
    tooShort: 'Recording too short',
    submitting: 'Submitting…',
    errorTooShort: 'Recording too short (< 5s), please try again',
    errorQuota: 'Cloned voice quota full ({{used}}/{{max}}). Delete one first.',
    errorConvert: 'Audio conversion failed, please try again',
    errorSubmit: 'Submit failed, please try again',
    errorGeneric: 'Operation failed, please try again',
  },

  // Change Password Modal
  changePassword: {
    title: 'Change Password',
    emailRequiredHint: 'Email address is required to update password.',
    newPassword: 'New Password',
    newPasswordPlaceholder: 'At least 8 characters',
    passwordHint: 'Password must be at least 8 characters',
    confirmPassword: 'Confirm Password',
    confirmPasswordPlaceholder: 'Confirm new password',
    submit: 'Change Password',
    success: 'Password Changed',
    successMessage: 'Your password has been updated successfully.',
    errorFillAll: 'Please fill in all fields.',
    errorTooShort: 'Password must be at least 8 characters.',
    errorMismatch: 'Passwords do not match.',
    errorFailed: 'Failed to change password. Please try again.',
  },

  // Login Methods
  loginMethod: {
    title: 'Login Methods',
    description: 'Manage your available login methods',
    statusEnabled: 'Enabled',
    statusDisabled: 'Not enabled',
    statusNoData: 'Not linked',
    providers: {
      google: 'Google',
      apple: 'Apple',
      email: 'Email',
      phiz: 'phiz',
    },
  },

  // Report Problem
  reportProblem: {
    title: 'Report a Problem',
    problemType: 'Problem Type',
    typeGeneral: 'General Issue',
    typeFeedback: 'Feedback',
    typeChildSafety: 'Child Safety',
    typeReplyFeedback: 'Reply Feedback',
    descriptionPlaceholder: 'Describe what went wrong',
    addImages: 'Add Images',
    submit: 'Submit',
    submitting: 'Submitting...',
    maxImages: 'Up to 5 images',
    descriptionRequired: 'Please describe the issue',
    submitFailed: 'Failed to submit. Please try again.',
    submitSuccess: 'Submitted',
    submitSuccessMessage: 'Thank you for your feedback. We will address it shortly.',
  },

  // Account Settings
  accountSettings: {
    title: 'Account Settings',
    changeAvatar: 'Change Avatar',
    avatarUploadFailed: 'Avatar upload failed. Please try again.',
    name: 'Name',
    namePlaceholder: 'Enter your name',
    email: 'Email',
    bio: 'Bio',
    bioPlaceholder: 'Tell us about yourself',
    save: 'Save',
    saved: 'Settings saved',
    saveFailed: 'Failed to save. Please try again.',
    permissionTitle: 'Permission Required',
    permissionDenied: 'Photo library access is required to change your avatar. Please enable it in Settings.',
    deleteAccount: 'Delete Account',
    deleteAccountConfirmTitle: 'Delete your account?',
    deleteAccountConfirmBody: 'This action is permanent and cannot be undone. Your profile, chat history, and all personal data will be deleted.',
    deleteAccountConfirmAction: 'Delete Permanently',
    deleteAccountFailed: 'Failed to delete account. Please try again.',
  },

  // Debug
  debug: {
    title: 'Debug',
    appInfo: 'App Info',
    version: 'Version',
    buildNumber: 'Build #',
    buildTime: 'Build Time',
    bundleId: 'Bundle ID',
    platform: 'Platform',
    apiBaseUrl: 'API Base URL',
    wsBaseUrl: 'WS Base URL',
    apiBaseUrlIp: 'Base URL IP',
    openDebugger: 'Open Dev Menu',
    openDebuggerDevHint: 'Opens the in-app Dev Menu. Tap "Open JS Debugger" to launch Chrome DevTools on your computer.',
    openDebuggerDevOnlyHint: 'Available in development builds only.',
    openDebuggerUnavailableTitle: 'Not Available',
    openDebuggerUnavailableMessage: 'Open Dev Menu only works in development builds.',
    viewSignature: 'View SHA1 Signature',
    sha1Label: 'SHA1:',
    loading: 'Loading...',
    copyToClipboard: 'Copied!',
    notAvailable: 'Not available',
    uploadLogs: 'Upload Client Logs',
    uploadLogsHint: 'Pack local logs and send to the server (used for debugging)',
    uploadStarting: 'Starting...',
    uploadComplete: 'Upload complete',
    uploadFailed: 'Upload Failed',
    uploadSuccess: 'Uploaded successfully',
    localLogStats: 'Local Log Stats',
    entryCount: 'Entries',
    fileSize: 'Size',
    fileName: 'File',
    serverFileSize: 'Server size',
    uploadId: 'Upload ID',
    writeSampleLogs: 'Write Sample Logs',
    clearLogs: 'Clear',
    clearLogsConfirmTitle: 'Clear all logs?',
    clearLogsConfirmMessage: 'This removes the local log file. Server-side uploads are kept.',
    clearLogsDone: 'Cleared',
    clearLogsDoneHint: 'Local logs cleared. Server-side uploads remain available to admins.',
    cancel: 'Cancel',
    confirm: 'Confirm',
  },

  // Legal Pages
  legal: {
    termsOfService: 'Terms of Service',
    privacyPolicy: 'Privacy Policy',
    openSourceLicenses: 'Open Source Licenses',
    agreeMessage: 'By continuing, you agree to our',
    and: 'and',
    disagree: 'Disagree',
    agreeAndContinue: 'Agree & Continue',
    welcomeTitle: 'Welcome to KDOO AI',
    welcomeMessage: 'Before using our service, please read and agree to:',
    languageSelect: 'Language',
    checkboxLabel: 'I have read and agree to the',
    alertTitle: 'Agreement Required',
    alertMessage: 'You must read and agree to the Terms of Service and Privacy Policy to continue.',
    alertConfirm: 'Agree',
    alertCancel: 'Cancel',
  },

  // WebView page
  webview: {
    title: 'Web',
    copyLink: 'Copy Link',
    copySuccess: 'Link copied',
    share: 'Share',
    invalidUrl: 'Invalid link',
    invalidUrlHint: 'Please check the link format and try again',
    loadFailed: 'Failed to load',
    retry: 'Retry',
  },

  // Search feature (SearXNG keywords + reference sources in AI messages)
  searchFeature: {
    searchKeywords: 'Search keywords',
    searching: 'searching...',
    searchingSources: 'Searching sources...',
    referenceCount: 'References: {{count}}',
    keywordsCount: '{{count}} keywords',
    resultsCount: '{{count}} results',
  },

  // Error
  error: {
    title: 'Error',
  },

  // Update prompt
  update: {
    title: 'New Version Available',
      versionInfo: 'Current {{current}} → Latest {{latest}}',
    releaseNotesLabel: 'What\'s new',
    download: 'Download Now',
    later: 'Later',
    gotIt: 'Got it',
  },

  // Map tool (preview card + navigation launch)
  map: {
      modeDrive: 'Drive',
      modeWalk: 'Walk',
      modeBike: 'Bike',
      modeTransit: 'Transit',
      preparing: 'Preparing map...',
      loadingRoute: 'Loading route...',
      noDestination: 'No destination',
      noDestinationMsg: 'Route is still loading. Please try again in a moment.',
      navUnavailable: 'Navigation unavailable',
      navUnavailableMsg: 'No map app found on this device.',
      // My Location tool
      myLocation: 'My Location',
      locating: 'Locating...',
      addressUnavailable: 'Address unavailable',
      // Nearby Search tool
      nearbySearch: 'Nearby Places',
      searchingNearby: 'Searching nearby...',
      placesFound: '{n} places found',
      noPlacesFound: 'No places found',
      andNMore: '(+{n} more)',
      openNow: 'Open now',
      closed: 'Closed',
      noMapApp: 'No map app found on this device',
      openUrlFailed: 'Could not open the map link',
    },
  // Validation (semantic keys from utils/schema.ts)
  validation: {
    required: 'This field is required',
    invalidEmail: 'Please enter a valid email',
    tooShort: 'Too short',
    tooLong: 'Too long',
    mismatch: 'Values do not match',
    invalidPattern: 'Invalid format',
  },

  // Image preview (fullscreen viewer: zoom + save to album)
  imagePreview: {
    close: 'Close',
    download: 'Save image',
    saved: 'Saved to photos',
    saveFailed: "Couldn't save image",
    permissionDenied: 'Please allow photo library access in system settings',
    previous: 'Previous image',
    next: 'Next image',
    save: 'Save',
    share: 'Share',
    shareFailed: 'Could not share image',
    loadFailed: 'Failed to load',
    downloadFailed: 'Download failed. Check your network and try again.',
  },
  // Memory: cross-session working memory & observational memory
  memory: {
    title: 'Memory',
    workingMemoryTitle: 'Working Memory',
    workingMemoryHint: 'Editable — enter your profile details',
    templateTitle: 'Memory Template',
    templateExpand: 'View template',
    templateCollapse: 'Collapse template',
    save: 'Save',
    saved: 'Saved',
    saveFailed: 'Failed to save. Please try again.',
    reset: 'Reset',
    resetting: 'Resetting...',
    resetConfirmTitle: 'Reset working memory?',
    resetConfirmBody: 'Your working memory will be cleared. This cannot be undone.',
    resetConfirmAction: 'Reset',
    loading: 'Loading memory...',
    loadFailed: 'Failed to load memory. Please retry.',
    workingPlaceholder: 'Enter your profile details (Markdown supported)',
  },
  share: {
    pleaseLoginFirst: 'Please sign in to open this share',
    forkFailed: 'Could not open this share. Please try again.',
    cancel: 'Cancel',
    send: 'Share',
  },
  call: {
    unknownNumber: 'Unknown number',
  },
};
