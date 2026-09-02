export default {
  // Common
  common: {
    cancel: '取消',
    delete: '删除',
    sessionExpired: '会话已过期，请重新登录',
    networkError: '网络连接失败，请检查网络设置',
    operationFailed: '操作失败，请重试',
  },

  // App
  app: {
    title: 'KDOO AI',
    starting: '应用启动中...',
    loading: '加载中...',
  },

  // 404
  notFound: {
    title: '页面未找到',
    message: '您访问的页面不存在。',
    goHome: '返回首页',
  },

  // Auth - Login
  login: {
    welcome: '欢迎回来',
    subtitle: '登录您的账号以继续',
    email: '邮箱',
    emailPlaceholder: 'your@email.com',
    password: '密码',
    forgotPassword: '忘记密码？',
    signIn: '登录',
    signingIn: '登录中...',
    orSignInWith: '或使用以下方式登录',
    noAccount: '还没有账号？',
    createAccount: '创建账号',
    loginFailed: '登录失败',
    loginFailedMsg: '请检查您的凭据后重试。',
    errorEmailRequired: '请输入邮箱',
    errorPasswordRequired: '请输入密码',
    errorPasswordShort: '密码至少需要 6 个字符',
    errorPasswordLong: '密码不能超过 50 个字符',
    errorInvalidEmail: '邮箱格式不正确',
    googleFailed: 'Google 登录失败',
    appleFailed: 'Apple 登录失败',
    tryAgain: '请重试。',
  },

  // Auth - Signup
  // Auth - Register
  register: {
    // Step 1 — Send verification code
    title: '创建账号',
    subtitle: '输入您的邮箱地址，我们将发送验证码',
    email: '邮箱',
    emailPlaceholder: 'your@email.com',
    sendCode: '发送验证码',
    sending: '发送中...',
    backToLogin: '返回登录',
    errorSend: '发送验证码失败，请重试。',
    errorEmailRequired: '请输入邮箱地址。',

    // Step 2 — Verify code
    enterCode: '输入验证码',
    codeSentTo: '验证码已发送至 ',
    verifyCode: '验证',
    verifying: '验证中...',
    resendCode: '重新发送',
    resendIn: '{{seconds}} 秒后可重新发送',
    errorCodeIncomplete: '请输入完整的 6 位验证码。',
    errorCodeVerify: '验证码错误或已过期，请重试。',

    // Step 3 — Set password & register
    setPassword: '设置密码',
    setPasswordHint: '请输入密码以创建账号',
    password: '密码',
    passwordPlaceholder: '至少 6 个字符',
    register: '创建账号',
    registering: '创建账号中...',
    errorPasswordRequired: '请输入密码。',
    errorPasswordShort: '密码至少需要 6 个字符。',
    errorPasswordMismatch: '两次密码输入不一致。',
    errorRegister: '注册失败，请重试。',
    passwordHint: '密码至少需要 6 个字符',
    confirmPassword: '确认密码',
    confirmPasswordPlaceholder: '再次输入密码',
    successTitle: '账号已创建',
    successMessage: '您的账号已成功创建，欢迎使用 KDOO AI！',
  },

  // Auth - Forgot Password
  forgotPassword: {
    title: '忘记密码？',
    subtitle: '输入您的邮箱地址，我们将发送验证码',
    email: '邮箱',
    emailPlaceholder: 'your@email.com',
    sendCode: '发送验证码',
    sending: '发送中...',
    backToSignIn: '返回登录',
    checkEmail: '请查看您的邮箱',
    sentTo: '我们已将密码重置链接发送至 ',
    errorSend: '发送验证码失败，请重试。',
    errorEmailRequired: '请输入邮箱地址。',
    errorInvalidEmail: '邮箱格式不正确。',

    // Step 2 — Verify code
    enterCode: '输入验证码',
    codeSentTo: '验证码已发送至 ',
    verifyCode: '验证',
    verifying: '验证中...',
    resendCode: '重新发送',
    resendIn: '{{seconds}} 秒后可重新发送',
    errorCodeIncomplete: '请输入完整的 6 位验证码。',
    errorCodeVerify: '验证码错误或已过期，请重试。',

    // Step 3 — Reset password
    setNewPassword: '设置新密码',
    setNewPasswordHint: '请输入您的新密码',
    newPassword: '新密码',
    newPasswordPlaceholder: '至少 6 个字符',
    confirmPassword: '确认密码',
    confirmPasswordPlaceholder: '再次输入新密码',
    passwordHint: '密码至少需要 6 个字符',
    resetPassword: '重置密码',
    resetting: '重置中...',
    errorPasswordRequired: '请输入新密码。',
    errorPasswordShort: '密码至少需要 6 个字符。',
    errorPasswordLong: '密码不能超过 50 个字符。',
    errorPasswordMismatch: '两次密码输入不一致。',
    errorReset: '密码重置失败，请重试。',
    successTitle: '密码已重置',
    successMessage: '您的密码已成功修改，请使用新密码登录。',
    autoRedirect: '秒后自动返回登录',
  },

  // Chat Home
  chatHome: {
    greeting: '你好，',
    howCanIHelp: '有什么可以帮到您？',
    actionTripRio: '规划一趟里约热内卢三日游',
    actionAstronautDog: '创建一张宇航员狗狗的图片',
    sending: '正在发送...',
  },

  // Chat Input
  chatInput: {
    placeholder: '输入您的消息...',
    creating: '正在创建会话...',
    images: '图片',
    camera: '拍照',
    files: '文件',
    listening: '正在聆听...',
    holdToSpeak: '按住说话',
    messagePlaceholder: '发消息...',
    messagePlaceholderHold: '发消息或按住说话...',
    location: '位置',
    voiceCall: '语音通话',
    uploadFailed: '附件处理失败',
  },

  // 照片编辑页(拍照/选图后配文发送)
  photoCompose: {
    cancel: '取消',
    title: '照片编辑',
    addCamera: '拍照添加',
    addGallery: '相册添加',
    placeholder: '说点什么...',
    placeholderView: '发送这张图片...',
  },

  // 相机页(应用内取景器)
  cameraScreen: {
    cancel: '取消',
    permissionTitle: '需要使用相机来拍照',
    enableCamera: '开启相机',
    deniedTitle: '相机权限未开启',
    deniedHint: '请在系统设置中开启相机权限',
    back: '返回',
  },

  // Voice Call
  voiceCall: {
    connecting: '正在连接...',
    listening: '正在聆听...',
    thinking: '正在思考...',
    speaking: '正在回答...',
    ready: '你可以开始说话',
    ended: '通话已结束',
    error: '连接失败，请重试',
    poorConnection: '网络较差，正在重连...',
    noNetwork: '网络较差，无法连接网络',
    serverUnreachable: '服务暂时不可用，正在重连...',
    contentByAI: '内容由 AI 生成',
    reconnecting: '正在重连...',
    transcriptToggle: '文字',
    transcriptError: '转录保存失败',
    sessionCreateFailed: '无法启动语音通话',
    sessionName: '语音通话 {{ts}}',
    micToggle: '麦克风',
    screenShare: '屏幕共享',
    camera: '摄像头',
    hangup: '结束通话',
  },

  // Chat Drawer
  chatDrawer: {
    searchChats: '搜索对话',
    newChat: '新对话',
    loadingChats: '加载对话中...',
    noConversations: '暂无对话',
    pinned: '已置顶',
    recent: '最近',
    justNow: '刚刚',
    minutesAgo: '分钟前',
    hoursAgo: '小时前',
    yesterday: '昨天',
    daysAgo: '天前',
    settings: '设置',
    unpin: '取消置顶',
    cancel: '取消',
    confirm: '确定',
    pin: '置顶',
    rename: '重命名',
    renamePlaceholder: '输入新名称',
    share: '分享',
    shareFailed: '分享失败，请稍后重试',
    delete: '删除',
    deleteConfirmTitle: '删除对话',
    deleteConfirmMessage: '确定要删除这个对话吗？',
  },

  // Chat View
  chatView: {
    loadingOlder: '加载更多消息...',
    sendFailed: '消息发送失败',
    replyTimeout: '回复超时，已自动重连',
    sessionNotFound: '会话不存在：{{id}}',
  },

  // AI creation completion (video/image)
  chat: {
    message: {
      videoReady: '你的视频生成好了',
      videoLoading: '视频加载中...',
      videoLoadFailed: '视频加载失败',
      videoDownload: '下载',
      videoSaving: '保存中...',
      videoDownloaded: '视频已保存到相册',
      videoDownloadFailed: '下载失败',
    },
  },

  // Video search results
  video: {
    showMore: '展开更多 ({{count}})',
  },

  // Music search results
  music: {
    showMore: '展开更多 ({{count}})',
    playbackFailed: '播放失败',
  },

  // Image search results
  image: {
    showMore: '展开更多 ({{count}})',
  },

  // Search Chats
  searchChats: {
    placeholder: '搜索对话',
    recentConversations: '最近的对话',
    noMatching: '未找到匹配的对话',
    noConversations: '暂无对话',
    today: '今天',
    yesterday: '昨天',
    daysAgo: ' 天前',
  },

  // Voice Overlay
  voiceOverlay: {
    slideUpToCancel: '↑ 上滑取消',
    releaseToCancel: '松开取消',
    noTextRecognized: '未识别到文字',
  },

  // Code Block
  codeBlock: {
    copy: '复制',
    copied: '已复制！',
  },

  // Button
  button: {
    loading: '加载中...',
  },

  // Time
  time: {
    justNow: '刚刚',
    today: '今天',
    minutesAgo: '分钟前',
    hoursAgo: '小时前',
    yesterday: '昨天',
    daysAgo: '天前',
    last7: '最近 7 天',
    lastMonth: '最近一个月',
    older: '更早',
  },

  // Profile Settings
  profileSettings: {
    title: '个人设置',
    profileActions: '个人操作',
    sectionAccount: '账号',
    sectionPreferences: '偏好',
    sectionAbout: '关于',
    accountSettings: '账号设置',
    themeSettings: '主题设置',
    languageSettings: '语言设置',
    changePassword: '修改密码',
    loginMethods: '登录方式',
    logOut: '退出登录',
    themeLight: '浅色',
    themeDark: '深色',
    themeSystem: '跟随系统',
    langChinese: '中文',
    langEnglish: 'English',
    langPortuguese: 'Português',
    saving: '保存中...',
    version: 'KDOO AI {{version}}',
    helloVisitor: '你好，访客！',
    themeUpdateFailed: '主题更新失败',
    languageUpdateFailed: '语言更新失败',
  },

  voiceSettings: {
    title: '声音',
    defaultVoiceTitle: '默认音色',
    defaultVoiceHint: '选一个你喜欢的音色',
    myClonedTitle: '我的克隆',
    myClonedCount: '{{used}}/{{max}}',
    cloneButton: '克隆我的声音',
    cloneTitle: '克隆我的声音',
    clonePrompt: '请朗读以下文本（5–30 秒）：',
    cloneSampleText: '今天天气真好，我想把这句祝福送给你，希望你的每一天都充满阳光。',
    cloneDefaultName: '我的声音 {{suffix}}',
    cloneStart: '开始录制',
    cloneStop: '停止录制',
    cloneSubmit: '提交',
    cloneConverting: '转换中…',
    cloneConvertFailed: '音频转换失败，请重试',
    cloneTooShort: '录制时长不足 5 秒',
    cloneTooLong: '已自动停止，超过 30 秒',
    clonePermissionDenied: '请授予麦克风权限',
    cloneSubmitFailed: '提交失败，请重试',
    training: '训练中…',
    failed: '失败: {{reason}}',
    failedShort: '失败',
    deleteConfirmTitle: '删除音色？',
    deleteConfirmBody: '确认删除「{{name}}」？',
    previewFailed: '试听失败',
    quotaExceeded: '已达克隆上限 ({{used}}/{{max}})，请先删除一个',
    loadingVoices: '加载音色…',
    emptyMyCloned: '尚未克隆音色',
    errorLoadVoices: '加载音色失败',
    saveFailed: '保存失败，请重试',
    rename: '修改名字',
    renameTitle: '修改音色名字',
    renamePlaceholder: '请输入新的名字',
    renameConfirm: '保存',
    renameEmpty: '名字不能为空',
    renameTooLong: '名字过长（最多 60 个字符）',
    renameFailed: '修改失败，请重试',
    tabMine: '我的',
    tabEn: '英语',
    tabZh: '中文',
    tabPt: '葡萄牙语',
    emptyGroup: '{{group}} 暂无音色',
  },

  voiceClone: {
    title: '克隆我的声音',
    prompt: '请朗读以下文本（5–30 秒）',
    holdToRecord: '按住 录制',
    recording: '录制中…',
    releaseToSubmit: '松开 提交',
    tooShort: '录制时长不足 5 秒',
    submitting: '提交中…',
    errorTooShort: '录制时长不足 5 秒，请重新录制',
    errorQuota: '已达克隆上限 ({{used}}/{{max}})，请先删除一个',
    errorConvert: '音频转换失败，请重试',
    errorSubmit: '提交失败，请重试',
    errorGeneric: '操作失败，请重试',
  },

  // Change Password Modal
  changePassword: {
    title: '修改密码',
    emailRequiredHint: '需要绑定邮箱才能修改密码。',
    newPassword: '新密码',
    newPasswordPlaceholder: '至少 8 个字符',
    passwordHint: '密码至少需要 8 个字符',
    confirmPassword: '确认密码',
    confirmPasswordPlaceholder: '确认新密码',
    submit: '修改密码',
    success: '密码已修改',
    successMessage: '您的密码已成功更新。',
    errorFillAll: '请填写所有字段。',
    errorTooShort: '密码至少需要 8 个字符。',
    errorMismatch: '两次密码输入不一致。',
    errorFailed: '密码修改失败，请重试。',
  },

  // Login Methods
  loginMethod: {
    title: '登录方式',
    description: '管理您可用的登录方式',
    statusEnabled: '已启用',
    statusDisabled: '未启用',
    statusNoData: '未绑定',
    providers: {
      google: 'Google',
      apple: 'Apple',
      email: 'Email',
      phiz: 'phiz',
    },
  },

  // Report Problem
  reportProblem: {
    title: '报告问题',
    problemType: '问题类型',
    typeGeneral: '一般问题',
    typeFeedback: '反馈问题',
    typeChildSafety: '儿童安全问题',
    typeReplyFeedback: '回复反馈',
    descriptionPlaceholder: '描述出了什么错误',
    addImages: '附加图像',
    submit: '提交',
    submitting: '提交中...',
    maxImages: '最多选择 5 张图片',
    descriptionRequired: '请填写问题描述',
    submitFailed: '提交失败，请重试。',
    submitSuccess: '提交成功',
    submitSuccessMessage: '感谢您的反馈，我们会尽快处理。',
  },

  // Account Settings
  accountSettings: {
    title: '账号设置',
    changeAvatar: '更换头像',
    avatarUploadFailed: '头像上传失败，请重试。',
    name: '姓名',
    namePlaceholder: '请输入您的姓名',
    email: '邮箱',
    bio: '简介',
    bioPlaceholder: '介绍一下你自己',
    save: '保存',
    saved: '设置已保存',
    saveFailed: '保存失败，请重试。',
    permissionTitle: '权限不足',
    permissionDenied: '需要相册权限才能更换头像，请在设置中开启。',
    deleteAccount: '删除账号',
    deleteAccountConfirmTitle: '确定删除账号？',
    deleteAccountConfirmBody: '此操作永久生效且无法撤销。您的个人资料、聊天记录和所有个人数据将被删除。',
    deleteAccountConfirmAction: '永久删除',
    deleteAccountFailed: '删除账号失败，请重试。',
  },

  // Debug
  debug: {
    title: '调试',
    appInfo: '应用信息',
    version: '版本',
    buildNumber: '构建号',
    buildTime: '构建时间',
    bundleId: '包名',
    platform: '平台',
    apiBaseUrl: '接口 Base URL',
    wsBaseUrl: 'WS Base URL',
    apiBaseUrlIp: '接口 IP',
    openDebugger: '打开开发者菜单',
    openDebuggerDevHint: '打开应用内开发者菜单。点击菜单中的 "Open JS Debugger" 在电脑上启动 Chrome DevTools。',
    openDebuggerDevOnlyHint: '仅在开发构建中可用。',
    openDebuggerUnavailableTitle: '不可用',
    openDebuggerUnavailableMessage: '打开开发者菜单仅在开发构建中可用。',
    viewSignature: '查看 SHA1 签名',
    sha1Label: 'SHA1：',
    loading: '加载中...',
    copyToClipboard: '已复制！',
    notAvailable: '不可用',
    uploadLogs: '上传客户端日志',
    uploadLogsHint: '打包本地日志并发送到服务器（仅用于排查问题）',
    uploadStarting: '正在准备...',
    uploadComplete: '上传完成',
    uploadFailed: '上传失败',
    uploadSuccess: '上传成功',
    localLogStats: '本地日志统计',
    entryCount: '条目数',
    fileSize: '大小',
    fileName: '文件名',
    serverFileSize: '服务端大小',
    uploadId: '上传 ID',
    writeSampleLogs: '写入示例日志',
    clearLogs: '清空',
    clearLogsConfirmTitle: '确认清空日志？',
    clearLogsConfirmMessage: '将删除本地日志文件，已上传到服务器的历史记录会保留。',
    clearLogsDone: '已清空',
    clearLogsDoneHint: '本地日志已清空，服务器端的历史上传仍可在管理后台查看。',
    cancel: '取消',
    confirm: '确认',
  },

  // Legal Pages
  legal: {
    termsOfService: '使用条款',
    privacyPolicy: '隐私协议',
    openSourceLicenses: '开源许可证',
    agreeMessage: '继续使用即表示您同意我们的',
    and: '和',
    disagree: '不同意',
    agreeAndContinue: '同意并继续',
    welcomeTitle: '欢迎使用 KDOO AI',
    welcomeMessage: '使用我们的服务前，请阅读并同意以下协议：',
    languageSelect: '语言',
    checkboxLabel: '我已阅读并同意',
    alertTitle: '需要同意协议',
    alertMessage: '您必须阅读并同意使用条款和隐私协议才能继续。',
    alertConfirm: '同意',
    alertCancel: '取消',
  },

  // WebView page
  webview: {
    title: '网页',
    copyLink: '复制链接',
    copySuccess: '链接已复制',
    share: '分享',
    invalidUrl: '无效的链接',
    invalidUrlHint: '请检查链接格式后重试',
    loadFailed: '加载失败',
    retry: '重试',
  },

  // Search feature (SearXNG keywords + reference sources in AI messages)
  searchFeature: {
    searchKeywords: '搜索关键词',
    searching: '搜索中...',
    searchingSources: '正在搜索来源...',
    referenceCount: '参考资料: {{count}}',
    keywordsCount: '{{count}} 关键词',
    resultsCount: '{{count}} 结果',
  },

  // Error
  error: {
    title: '错误',
  },

  // Update prompt
  update: {
    title: '发现新版本',
      versionInfo: '当前版本 {{current}} → 最新版本 {{latest}}',
    releaseNotesLabel: '更新内容',
    download: '立即下载',
    later: '稍后再说',
    gotIt: '我知道了',
  },

  // Map tool (preview card + navigation launch)
  map: {
      modeDrive: '驾车',
      modeWalk: '步行',
      modeBike: '骑行',
      modeTransit: '公交',
      preparing: '正在准备地图...',
      loadingRoute: '正在计算路线...',
      noDestination: '无目的地',
      noDestinationMsg: '路线正在计算中，请稍后重试。',
      navUnavailable: '无法导航',
      navUnavailableMsg: '未找到地图应用。',
      // My Location tool
      myLocation: '我的位置',
      locating: '定位中...',
      addressUnavailable: '无法获取地址',
      // Nearby Search tool
      nearbySearch: '附近地点',
      searchingNearby: '正在搜索附近...',
      placesFound: '找到 {n} 个地点',
      noPlacesFound: '未找到地点',
      andNMore: '(还有 {n} 个)',
      openNow: '营业中',
      closed: '已打烊',
      noMapApp: '未找到可用的地图应用',
      openUrlFailed: '无法打开地图链接',
    },
  // Validation (semantic keys from utils/schema.ts)
  validation: {
    required: '此项不能为空',
    invalidEmail: '邮箱格式不正确',
    tooShort: '输入太短',
    tooLong: '输入太长',
    mismatch: '两次输入不一致',
    invalidPattern: '格式不正确',
  },

  // 图片预览（全屏查看器：缩放与保存到相册）
  imagePreview: {
    close: '关闭',
    download: '保存图片',
    saved: '已保存到相册',
    saveFailed: '保存失败',
    permissionDenied: '保存失败,请在系统设置中允许访问相册',
    previous: '上一张',
    next: '下一张',
    save: '保存',
    share: '分享',
    shareFailed: '分享失败',
    loadFailed: '加载失败',
    downloadFailed: '下载图片失败，请检查网络后重试',
  },
  // Memory: cross-session working memory & observational memory
  memory: {
    title: '记忆',
    workingMemoryTitle: '工作记忆',
    workingMemoryHint: '可编辑 — 填写你的个人资料',
    templateTitle: '记忆模板',
    templateExpand: '查看模板',
    templateCollapse: '收起模板',
    save: '保存',
    saved: '已保存',
    saveFailed: '保存失败，请重试',
    reset: '重置',
    resetting: '重置中...',
    resetConfirmTitle: '重置工作记忆？',
    resetConfirmBody: '工作记忆将被清空，此操作不可撤销。',
    resetConfirmAction: '重置',
    loading: '正在加载记忆...',
    loadFailed: '加载记忆失败，请重试',
    workingPlaceholder: '输入你的个人资料（支持 Markdown）',
  },
  share: {
    pleaseLoginFirst: '请先登录后再打开分享',
    forkFailed: '打开分享失败，请稍后重试',
    cancel: '取消',
    send: '分享',
  },
  call: {
    unknownNumber: '未知号码',
  },
};
