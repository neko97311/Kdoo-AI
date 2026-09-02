export default {
  // Common
  common: {
    cancel: 'Cancelar',
    delete: 'Excluir',
    sessionExpired: 'Sessão expirada. Entre novamente.',
    networkError: 'Falha na conexão. Verifique sua rede.',
    operationFailed: 'Falha na operação. Tente novamente.',
  },

  // App
  app: {
    title: 'KDOO AI',
    starting: 'Iniciando aplicativo...',
    loading: 'Carregando...',
  },

  // 404
  notFound: {
    title: 'Página não encontrada',
    message: 'A página que você está procurando não existe.',
    goHome: 'Voltar ao início',
  },

  // Auth - Login
  login: {
    welcome: 'Bem-vindo de volta',
    subtitle: 'Entre na sua conta para continuar',
    email: 'E-mail',
    emailPlaceholder: 'seu@email.com',
    password: 'Senha',
    forgotPassword: 'Esqueceu a senha?',
    signIn: 'Entrar',
    signingIn: 'Entrando...',
    orSignInWith: 'Ou entre com',
    noAccount: 'Não tem uma conta? ',
    createAccount: 'Criar conta',
    loginFailed: 'Falha no login',
    loginFailedMsg: 'Verifique suas credenciais e tente novamente.',
    errorEmailRequired: 'Por favor, insira seu e-mail',
    errorPasswordRequired: 'Por favor, insira sua senha',
    errorPasswordShort: 'A senha deve ter pelo menos 6 caracteres',
    errorPasswordLong: 'A senha não pode exceder 50 caracteres',
    errorInvalidEmail: 'Formato de e-mail inválido',
    googleFailed: 'Falha no login com Google',
    appleFailed: 'Falha no login com Apple',
    tryAgain: 'Por favor, tente novamente.',
  },

  // Auth - Signup
  // Auth - Register
  register: {
    // Step 1 — Send verification code
    title: 'Criar Conta',
    subtitle: 'Digite seu endereço de e-mail e enviaremos um código de verificação',
    email: 'E-mail',
    emailPlaceholder: 'seu@email.com',
    sendCode: 'Enviar código',
    sending: 'Enviando...',
    backToLogin: 'Voltar para o login',
    errorSend: 'Falha ao enviar o código. Por favor, tente novamente.',
    errorEmailRequired: 'Por favor, insira seu endereço de e-mail.',

    // Step 2 — Verify code
    enterCode: 'Insira o código',
    codeSentTo: 'Um código foi enviado para ',
    verifyCode: 'Verificar',
    verifying: 'Verificando...',
    resendCode: 'Reenviar',
    resendIn: 'Reenviar em {{seconds}}s',
    errorCodeIncomplete: 'Por favor, insira o código de 6 dígitos.',
    errorCodeVerify: 'Código incorreto ou expirado. Tente novamente.',

    // Step 3 — Set password & register
    setPassword: 'Definir senha',
    setPasswordHint: 'Digite sua senha para criar a conta',
    password: 'Senha',
    passwordPlaceholder: 'Pelo menos 6 caracteres',
    register: 'Criar conta',
    registering: 'Criando conta...',
    errorPasswordRequired: 'Por favor, insira uma senha.',
    errorPasswordShort: 'A senha deve ter pelo menos 6 caracteres.',
    errorPasswordMismatch: 'As senhas não coincidem.',
    errorRegister: 'Falha no registro. Por favor, tente novamente.',
    passwordHint: 'A senha deve ter pelo menos 6 caracteres',
    confirmPassword: 'Confirmar senha',
    confirmPasswordPlaceholder: 'Digite a senha novamente',
    successTitle: 'Conta criada',
    successMessage: 'Sua conta foi criada com sucesso. Bem-vindo ao KDOO AI!',
  },

  // Auth - Forgot Password
  forgotPassword: {
    title: 'Esqueceu a senha?',
    subtitle: 'Digite seu endereço de e-mail e enviaremos um código de verificação',
    email: 'E-mail',
    emailPlaceholder: 'seu@email.com',
    sendCode: 'Enviar código',
    sending: 'Enviando...',
    backToSignIn: 'Voltar para o login',
    checkEmail: 'Verifique seu e-mail',
    sentTo: 'Enviamos um link de redefinição de senha para ',
    errorSend: 'Falha ao enviar o código. Por favor, tente novamente.',
    errorEmailRequired: 'Por favor, insira seu endereço de e-mail.',
    errorInvalidEmail: 'Formato de e-mail inválido.',

    enterCode: 'Insira o código',
    codeSentTo: 'Um código foi enviado para ',
    verifyCode: 'Verificar',
    verifying: 'Verificando...',
    resendCode: 'Reenviar',
    resendIn: 'Reenviar em {{seconds}}s',
    errorCodeIncomplete: 'Por favor, insira o código de 6 dígitos.',
    errorCodeVerify: 'Código incorreto ou expirado. Tente novamente.',

    setNewPassword: 'Definir nova senha',
    setNewPasswordHint: 'Digite sua nova senha',
    newPassword: 'Nova senha',
    newPasswordPlaceholder: 'Pelo menos 6 caracteres',
    confirmPassword: 'Confirmar senha',
    confirmPasswordPlaceholder: 'Digite a nova senha novamente',
    passwordHint: 'A senha deve ter pelo menos 6 caracteres',
    resetPassword: 'Redefinir senha',
    resetting: 'Redefinindo...',
    errorPasswordRequired: 'Por favor, insira uma nova senha.',
    errorPasswordShort: 'A senha deve ter pelo menos 6 caracteres.',
    errorPasswordLong: 'A senha não pode exceder 50 caracteres.',
    errorPasswordMismatch: 'As senhas não coincidem.',
    errorReset: 'Falha ao redefinir a senha. Tente novamente.',
    successTitle: 'Senha redefinida',
    successMessage: 'Sua senha foi alterada com sucesso. Faça login com a nova senha.',
    autoRedirect: 'Retornando ao login em',
  },

  // Chat Home
  chatHome: {
    greeting: 'Olá,',
    howCanIHelp: 'como posso ajudar?',
    actionTripRio: 'Planeje uma viagem de 3 dias ao Rio de Janeiro',
    actionAstronautDog: 'Crie uma imagem de um cachorro astronauta',
    sending: 'Enviando...',
  },

  // Chat Input
  chatInput: {
    placeholder: 'Digite sua mensagem...',
    creating: 'Criando sessão...',
    images: 'Imagens',
    camera: 'Câmera',
    files: 'Arquivos',
    listening: 'Ouvindo...',
    holdToSpeak: 'Segure para falar',
    messagePlaceholder: 'Mensagem...',
    messagePlaceholderHold: 'Digite ou segure para falar...',
    location: 'Localização',
    voiceCall: 'Chamar',
    uploadFailed: 'Falha ao processar o anexo',
  },

  // Photo compose screen (caption photos after capture/pick, then send)
  photoCompose: {
    cancel: 'Cancelar',
    title: 'Editar Foto',
    addCamera: 'Adicionar Foto',
    addGallery: 'Adicionar da Galeria',
    placeholder: 'Diga algo...',
    placeholderView: 'Enviar esta imagem...',
  },

  // Camera screen (in-app viewfinder)
  cameraScreen: {
    cancel: 'Cancelar',
    permissionTitle: 'Precisamos de acesso à câmera para tirar fotos',
    enableCamera: 'Ativar Câmera',
    deniedTitle: 'Acesso à câmera desativado',
    deniedHint: 'Ative a permissão de câmera nas configurações do sistema',
    back: 'Voltar',
  },

  // Voice Call
  voiceCall: {
    connecting: 'Conectando...',
    listening: 'Ouvindo...',
    thinking: 'Pensando...',
    speaking: 'Falando...',
    ready: 'Você pode começar a falar',
    ended: 'Chamada encerrada',
    error: 'Falha na conexão, tente novamente',
    poorConnection: 'Conexão instável, reconectando...',
    noNetwork: 'Rede ruim, não foi possível conectar',
    serverUnreachable: 'Serviço indisponível, reconectando...',
    contentByAI: 'Conteúdo gerado por IA',
    reconnecting: 'Reconectando...',
    transcriptToggle: 'Transcrição',
    transcriptError: 'Falha ao salvar transcrição',
    sessionCreateFailed: 'Falha ao iniciar chamada',
    sessionName: 'Chamada de voz {{ts}}',
    micToggle: 'Microfone',
    screenShare: 'Compartilhar tela',
    camera: 'Câmera',
    hangup: 'Encerrar chamada',
  },

  // Chat Drawer
  chatDrawer: {
    searchChats: 'Buscar conversas',
    newChat: 'Nova conversa',
    loadingChats: 'Carregando conversas...',
    noConversations: 'Nenhuma conversa ainda',
    pinned: 'Fixados',
    recent: 'Recentes',
    justNow: 'Agora mesmo',
    minutesAgo: 'min atrás',
    hoursAgo: 'h atrás',
    yesterday: 'Ontem',
    daysAgo: 'd atrás',
    settings: 'Configurações',
    share: 'Compartilhar',
    shareFailed: 'Falha ao compartilhar. Tente novamente.',
  },

  // Chat Bottom Sheet
  chatBottomSheet: {
    pin: 'Fixar',
    rename: 'Renomear',
    delete: 'Excluir',
  },

  // Chat View
  chatView: {
    loadingOlder: 'Carregando mensagens antigas...',
    sendFailed: 'Falha ao enviar a mensagem',
    replyTimeout: 'Tempo de resposta esgotado. Reconectando automaticamente.',
    sessionNotFound: 'Sessão de conversa não encontrada: {{id}}',
  },

  // AI creation completion (video/image)
  chat: {
    message: {
      videoReady: 'O seu vídeo está pronto',
      videoLoading: 'A carregar vídeo...',
      videoLoadFailed: 'Falha ao carregar o vídeo',
      videoDownload: 'Baixar',
      videoSaving: 'A guardar...',
      videoDownloaded: 'Vídeo guardado na galeria',
      videoDownloadFailed: 'Falha no download',
    },
  },

  // Video search results
  video: {
    showMore: 'Mostrar mais ({{count}})',
  },

  // Music search results
  music: {
    showMore: 'Mostrar mais ({{count}})',
    playbackFailed: 'Falha na reprodução',
  },

  // Image search results
  image: {
    showMore: 'Mostrar mais ({{count}})',
  },

  // Search Chats
  searchChats: {
    placeholder: 'Buscar conversas',
    recentConversations: 'Conversas recentes',
    noMatching: 'Nenhuma conversa encontrada',
    noConversations: 'Nenhuma conversa ainda',
    today: 'Hoje',
    yesterday: 'Ontem',
    daysAgo: ' dias atrás',
  },

  // Voice Overlay
  voiceOverlay: {
    slideUpToCancel: '↑ Deslize para cancelar',
    releaseToCancel: 'Solte para cancelar',
    noTextRecognized: 'Fala não reconhecida',
  },

  // Code Block
  codeBlock: {
    copy: 'Copiar',
    copied: 'Copiado!',
  },

  // Button
  button: {
    loading: 'Carregando...',
  },

  // Time
  time: {
    justNow: 'Agora mesmo',
    today: 'Hoje',
    minutesAgo: 'min atrás',
    hoursAgo: 'h atrás',
    yesterday: 'Ontem',
    daysAgo: 'd atrás',
    last7: 'Últimos 7 dias',
    lastMonth: 'Último mês',
    older: 'Mais antigo',
  },

  // Profile Settings
  profileSettings: {
    title: 'Configurações do perfil',
    profileActions: 'Ações do perfil',
    sectionAccount: 'Conta',
    sectionPreferences: 'Preferências',
    sectionAbout: 'Sobre',
    accountSettings: 'Configurações da conta',
    themeSettings: 'Configurações de tema',
    languageSettings: 'Configurações de idioma',
    changePassword: 'Alterar senha',
    loginMethods: 'Métodos de Login',
    logOut: 'Sair',
    themeLight: 'Claro',
    themeDark: 'Escuro',
    themeSystem: 'Seguir Sistema',
    langChinese: '中文',
    langEnglish: 'English',
    langPortuguese: 'Português',
    saving: 'Salvando...',
    version: 'KDOO AI {{version}}',
    helloVisitor: 'Olá, Visitante!',
    themeUpdateFailed: 'Falha ao atualizar o tema',
    languageUpdateFailed: 'Falha ao atualizar o idioma',
  },

  voiceSettings: {
    title: 'Voz',
    defaultVoiceTitle: 'Voz padrão',
    defaultVoiceHint: 'Escolha uma voz que você goste',
    myClonedTitle: 'Minhas vozes clonadas',
    myClonedCount: '{{used}}/{{max}}',
    cloneButton: 'Clonar minha voz',
    cloneTitle: 'Clonar minha voz',
    clonePrompt: 'Leia o texto abaixo (5–30 segundos):',
    cloneSampleText: 'Hoje é um dia lindo, e quero compartilhar esta bênção com você. Que cada dia seja preenchido com luz do sol.',
    cloneDefaultName: 'Minha voz {{suffix}}',
    cloneStart: 'Começar a gravar',
    cloneStop: 'Parar gravação',
    cloneSubmit: 'Enviar',
    cloneConverting: 'Convertendo…',
    cloneConvertFailed: 'Falha na conversão do áudio, tente novamente',
    cloneTooShort: 'Gravação muito curta (< 5s)',
    cloneTooLong: 'Parada automática (> 30s)',
    clonePermissionDenied: 'Conceda permissão de microfone',
    cloneSubmitFailed: 'Falha ao enviar, tente novamente',
    training: 'Treinando…',
    failed: 'Falhou: {{reason}}',
    failedShort: 'Falhou',
    deleteConfirmTitle: 'Excluir voz?',
    deleteConfirmBody: 'Excluir "{{name}}"?',
    previewFailed: 'Falha na amostra',
    quotaExceeded: 'Cota cheia ({{used}}/{{max}}). Exclua uma primeiro.',
    loadingVoices: 'Carregando vozes…',
    emptyMyCloned: 'Nenhuma voz clonada ainda',
    errorLoadVoices: 'Falha ao carregar vozes',
    saveFailed: 'Falha ao salvar, tente novamente',
    rename: 'Renomear',
    renameTitle: 'Renomear voz',
    renamePlaceholder: 'Digite um novo nome',
    renameConfirm: 'Salvar',
    renameEmpty: 'O nome não pode estar vazio',
    renameTooLong: 'Nome muito longo (máx. 60 caracteres)',
    renameFailed: 'Falha ao renomear, tente novamente',
    tabMine: 'Minhas',
    tabEn: 'Inglês',
    tabZh: 'Chinês',
    tabPt: 'Português',
    emptyGroup: 'Nenhuma voz em {{group}}',
  },

  voiceClone: {
    title: 'Clonar Minha Voz',
    prompt: 'Leia o texto abaixo (5–30 segundos)',
    holdToRecord: 'Segure para Gravar',
    recording: 'Gravando…',
    releaseToSubmit: 'Solte para Enviar',
    tooShort: 'Gravação muito curta',
    submitting: 'Enviando…',
    errorTooShort: 'Gravação muito curta (< 5s), tente novamente',
    errorQuota: 'Cota cheia ({{used}}/{{max}}). Exclua uma primeiro.',
    errorConvert: 'Falha na conversão do áudio, tente novamente',
    errorSubmit: 'Falha ao enviar, tente novamente',
    errorGeneric: 'Falha na operação, tente novamente',
  },

  // Change Password Modal
  changePassword: {
    title: 'Alterar senha',
    emailRequiredHint: 'É necessário ter um e-mail cadastrado para alterar a senha.',
    newPassword: 'Nova senha',
    newPasswordPlaceholder: 'Pelo menos 8 caracteres',
    passwordHint: 'A senha deve ter pelo menos 8 caracteres',
    confirmPassword: 'Confirmar senha',
    confirmPasswordPlaceholder: 'Confirmar nova senha',
    submit: 'Alterar senha',
    success: 'Senha alterada',
    successMessage: 'Sua senha foi atualizada com sucesso.',
    errorFillAll: 'Por favor, preencha todos os campos.',
    errorTooShort: 'A senha deve ter pelo menos 8 caracteres.',
    errorMismatch: 'As senhas não coincidem.',
    errorFailed: 'Falha ao alterar a senha. Por favor, tente novamente.',
  },

  // Login Methods
  loginMethod: {
    title: 'Métodos de Login',
    description: 'Gerencie seus métodos de login disponíveis',
    statusEnabled: 'Ativado',
    statusDisabled: 'Desativado',
    statusNoData: 'Não vinculado',
    providers: {
      google: 'Google',
      apple: 'Apple',
      email: 'E-mail',
      phiz: 'phiz',
    },
  },

  // Report Problem
  reportProblem: {
    title: 'Relatar Problema',
    problemType: 'Tipo de Problema',
    typeGeneral: 'Problema Geral',
    typeFeedback: 'Feedback',
    typeChildSafety: 'Segurança Infantil',
    typeReplyFeedback: 'Responder Feedback',
    descriptionPlaceholder: 'Descreva o que deu errado',
    addImages: 'Adicionar Imagens',
    submit: 'Enviar',
    submitting: 'Enviando...',
    maxImages: 'Até 5 imagens',
    descriptionRequired: 'Descreva o problema',
    submitFailed: 'Falha ao enviar. Tente novamente.',
    submitSuccess: 'Enviado',
    submitSuccessMessage: 'Obrigado pelo seu feedback. Resolveremos em breve.',
  },

  // Account Settings
  accountSettings: {
    title: 'Configurações da conta',
    changeAvatar: 'Alterar avatar',
    avatarUploadFailed: 'Falha ao enviar o avatar. Tente novamente.',
    name: 'Nome',
    namePlaceholder: 'Digite seu nome',
    email: 'E-mail',
    bio: 'Biografia',
    bioPlaceholder: 'Fale um pouco sobre você',
    save: 'Salvar',
    saved: 'Configurações salvas',
    saveFailed: 'Falha ao salvar. Tente novamente.',
    permissionTitle: 'Permissão necessária',
    permissionDenied: 'O acesso à galeria de fotos é necessário para alterar seu avatar. Ative-o nas Configurações.',
    deleteAccount: 'Excluir conta',
    deleteAccountConfirmTitle: 'Excluir sua conta?',
    deleteAccountConfirmBody: 'Esta ação é permanente e não pode ser desfeita. Seu perfil, histórico de conversas e todos os dados pessoais serão excluídos.',
    deleteAccountConfirmAction: 'Excluir permanentemente',
    deleteAccountFailed: 'Falha ao excluir a conta. Tente novamente.',
  },

  // Debug
  debug: {
    title: 'Depuração',
    appInfo: 'Info do App',
    version: 'Versão',
    buildNumber: 'Build #',
    buildTime: 'Horário de Build',
    bundleId: 'Bundle ID',
    platform: 'Plataforma',
    apiBaseUrl: 'URL Base da API',
    wsBaseUrl: 'URL Base do WS',
    apiBaseUrlIp: 'IP da URL Base',
    openDebugger: 'Abrir Menu Dev',
    openDebuggerDevHint: 'Abre o menu de desenvolvedor no app. Toque em "Open JS Debugger" para iniciar o Chrome DevTools no seu computador.',
    openDebuggerDevOnlyHint: 'Disponível apenas em builds de desenvolvimento.',
    openDebuggerUnavailableTitle: 'Indisponível',
    openDebuggerUnavailableMessage: 'Abrir Menu Dev só funciona em builds de desenvolvimento.',
    viewSignature: 'Ver Assinatura SHA1',
    sha1Label: 'SHA1:',
    loading: 'Carregando...',
    copyToClipboard: 'Copiado!',
    notAvailable: 'Não disponível',
    uploadLogs: 'Enviar Logs do Cliente',
    uploadLogsHint: 'Empacotar logs locais e enviar ao servidor (usado para depuração)',
    uploadStarting: 'Iniciando...',
    uploadComplete: 'Envio concluído',
    uploadFailed: 'Falha no Envio',
    uploadSuccess: 'Enviado com sucesso',
    localLogStats: 'Estatísticas locais',
    entryCount: 'Entradas',
    fileSize: 'Tamanho',
    fileName: 'Arquivo',
    serverFileSize: 'Tamanho no servidor',
    uploadId: 'ID do envio',
    writeSampleLogs: 'Gravar logs de amostra',
    clearLogs: 'Limpar',
    clearLogsConfirmTitle: 'Limpar todos os logs?',
    clearLogsConfirmMessage: 'Remove o arquivo de log local. Os envios no servidor são mantidos.',
    clearLogsDone: 'Limpos',
    clearLogsDoneHint: 'Logs locais removidos. Os envios no servidor permanecem disponíveis.',
    cancel: 'Cancelar',
    confirm: 'Confirmar',
  },

  // Legal Pages
  legal: {
    termsOfService: 'Termos de Serviço',
    privacyPolicy: 'Política de Privacidade',
    openSourceLicenses: 'Licenças de Código Aberto',
    agreeMessage: 'Ao continuar, você concorda com nossos',
    and: 'e',
    disagree: 'Discordar',
    agreeAndContinue: 'Concordar e Continuar',
    welcomeTitle: 'Bem-vindo ao KDOO AI',
    welcomeMessage: 'Antes de usar nosso serviço, leia e concorde com:',
    languageSelect: 'Idioma',
    checkboxLabel: 'Eu li e concordo com os',
    alertTitle: 'Acordo Necessário',
    alertMessage: 'Você deve ler e concordar com os Termos de Serviço e a Política de Privacidade para continuar.',
    alertConfirm: 'Concordar',
    alertCancel: 'Cancelar',
  },

  // WebView page
  webview: {
    title: 'Página',
    copyLink: 'Copiar link',
    copySuccess: 'Link copiado',
    share: 'Compartilhar',
    invalidUrl: 'Link inválido',
    invalidUrlHint: 'Verifique o formato do link e tente novamente',
    loadFailed: 'Falha ao carregar',
    retry: 'Tentar novamente',
  },

  // Search feature (SearXNG keywords + reference sources in AI messages)
  searchFeature: {
    searchKeywords: 'Palavras-chave de busca',
    searching: 'buscando...',
    searchingSources: 'Buscando fontes...',
    referenceCount: 'Referências: {{count}}',
    keywordsCount: '{{count}} palavras-chave',
    resultsCount: '{{count}} resultados',
  },

  // Error
  error: {
    title: 'Erro',
  },

  // Update prompt
  update: {
    title: 'Nova versão disponível',
      versionInfo: 'Atual {{current}} → Mais recente {{latest}}',
    releaseNotesLabel: 'Novidades',
    download: 'Baixar agora',
    later: 'Mais tarde',
    gotIt: 'Entendi',
  },

  // Map tool (preview card + navigation launch)
  map: {
      modeDrive: 'Dirigir',
      modeWalk: 'Andar',
      modeBike: 'Bicicleta',
      modeTransit: 'Transporte',
      preparing: 'Preparando mapa...',
      loadingRoute: 'Carregando rota...',
      noDestination: 'Sem destino',
      noDestinationMsg: 'A rota ainda está carregando. Tente novamente em alguns instantes.',
      navUnavailable: 'Navegação indisponível',
      navUnavailableMsg: 'Nenhum aplicativo de mapas encontrado neste dispositivo.',
      // My Location tool
      myLocation: 'Minha Localização',
      locating: 'Localizando...',
      addressUnavailable: 'Endereço indisponível',
      // Nearby Search tool
      nearbySearch: 'Locais Próximos',
      searchingNearby: 'Buscando locais próximos...',
      placesFound: '{n} locais encontrados',
      noPlacesFound: 'Nenhum local encontrado',
      andNMore: '(+{n} mais)',
      openNow: 'Aberto agora',
      closed: 'Fechado',
      noMapApp: 'Nenhum app de mapas encontrado neste dispositivo',
      openUrlFailed: 'Não foi possível abrir o link do mapa',
    },
  // Validation (semantic keys from utils/schema.ts)
  validation: {
    required: 'Este campo é obrigatório',
    invalidEmail: 'Por favor insira um email válido',
    tooShort: 'Muito curto',
    tooLong: 'Muito longo',
    mismatch: 'Os valores não coincidem',
    invalidPattern: 'Formato inválido',
  },

  // Visualização de imagem (tela cheia: zoom e salvar na galeria)
  imagePreview: {
    close: 'Fechar',
    download: 'Salvar imagem',
    saved: 'Salvo na galeria',
    saveFailed: 'Falha ao salvar',
    permissionDenied: 'Permita o acesso à galeria nas configurações do sistema',
    previous: 'Imagem anterior',
    next: 'Próxima imagem',
    save: 'Salvar',
    share: 'Compartilhar',
    shareFailed: 'Falha ao compartilhar',
    loadFailed: 'Falha ao carregar',
    downloadFailed: 'Falha ao baixar a imagem. Verifique a rede e tente novamente.',
  },
  // Memória: memória de trabalho entre sessões e memória observacional
  memory: {
    title: 'Memória',
    workingMemoryTitle: 'Memória de Trabalho',
    workingMemoryHint: 'Editável — insira os seus dados de perfil',
    templateTitle: 'Modelo de Memória',
    templateExpand: 'Ver modelo',
    templateCollapse: 'Recolher modelo',
    save: 'Salvar',
    saved: 'Salvo',
    saveFailed: 'Falha ao salvar. Tente novamente.',
    reset: 'Redefinir',
    resetting: 'Redefinindo...',
    resetConfirmTitle: 'Redefinir a memória de trabalho?',
    resetConfirmBody: 'A sua memória de trabalho será apagada. Esta ação não pode ser desfeita.',
    resetConfirmAction: 'Redefinir',
    loading: 'Carregando memória...',
    loadFailed: 'Falha ao carregar a memória. Tente novamente.',
    workingPlaceholder: 'Insira os seus dados de perfil (Markdown suportado)',
  },
  share: {
    pleaseLoginFirst: 'Entre para abrir este compartilhamento',
    forkFailed: 'Não foi possível abrir este compartilhamento. Tente novamente.',
  },
};
