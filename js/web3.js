/**
 * web3.js — PengPool × Abstract Global Wallet integration
 *
 * Cargado como <script src="js/web3.js"> (SIN type="module").
 * window.PengPoolWeb3 queda disponible de forma SÍNCRONA en cuanto el script
 * se ejecuta — antes de cualquier clic del usuario.
 *
 * Flujo de conexión:
 *  1. Se carga @abstract-foundation/agw-web/testnet en background.
 *     Este paquete anuncia AGW como proveedor EIP-6963 (vía Privy).
 *  2. Al conectar, se descubre el proveedor AGW por EIP-6963.
 *  3. Si no se encuentra AGW, se usa window.ethereum (MetaMask) como fallback.
 *  4. Se crea un walletClient de viem extendido con eip712WalletActions()
 *     (necesario para firmar transacciones en ZKSync / Abstract).
 */

(function () {
  "use strict";

  // ── Contrato ──────────────────────────────────────────────────────────────

  var PENGPOOL_ADDRESS = "0xEeA18855Ffd6824dB84e17e27E616771dFAbfC1F";

  var PENGPOOL_ABI = [
    { name:"betAmountWei",  type:"function", stateMutability:"view",
      inputs:[{name:"usdAmount",type:"uint8"}], outputs:[{name:"",type:"uint256"}] },
    { name:"getOpenGames",  type:"function", stateMutability:"view",
      inputs:[], outputs:[{name:"",type:"uint256[]"}] },
    { name:"getGame",       type:"function", stateMutability:"view",
      inputs:[{name:"gameId",type:"uint256"}],
      outputs:[{name:"",type:"tuple",components:[
        {name:"player1",  type:"address"},
        {name:"player2",  type:"address"},
        {name:"betAmount",type:"uint256"},
        {name:"betUSD",   type:"uint8"},
        {name:"status",   type:"uint8"},
        {name:"winner",   type:"address"},
      ]}] },
    { name:"createGame",    type:"function", stateMutability:"payable",
      inputs:[{name:"betUSD",type:"uint8"}], outputs:[{name:"gameId",type:"uint256"}] },
    { name:"joinGame",      type:"function", stateMutability:"payable",
      inputs:[{name:"gameId",type:"uint256"}], outputs:[] },
    { name:"declareWinner", type:"function", stateMutability:"nonpayable",
      inputs:[{name:"gameId",type:"uint256"},{name:"winner",type:"address"}], outputs:[] },
    { name:"cancelGame",    type:"function", stateMutability:"nonpayable",
      inputs:[{name:"gameId",type:"uint256"}], outputs:[] },
    { name:"GameCreated",   type:"event",
      inputs:[{name:"gameId",type:"uint256",indexed:true},{name:"player1",type:"address",indexed:true},
              {name:"betAmount",type:"uint256",indexed:false},{name:"betUSD",type:"uint8",indexed:false}] },
    { name:"PlayerJoined",  type:"event",
      inputs:[{name:"gameId",type:"uint256",indexed:true},{name:"player2",type:"address",indexed:true}] },
    { name:"WinnerDeclared",type:"event",
      inputs:[{name:"gameId",type:"uint256",indexed:true},{name:"winner",type:"address",indexed:true},
              {name:"prize",type:"uint256",indexed:false},{name:"commission",type:"uint256",indexed:false}] },
    { name:"GameCancelled", type:"event",
      inputs:[{name:"gameId",type:"uint256",indexed:true},{name:"player1",type:"address",indexed:true},
              {name:"refund",type:"uint256",indexed:false}] },
  ];

  var GameStatus = Object.freeze({ OPEN:0, ACTIVE:1, FINISHED:2, CANCELLED:3 });

  // ── Estado interno ────────────────────────────────────────────────────────

  var _pub  = null;   // publicClient  (lecturas)
  var _abs  = null;   // walletClient + eip712WalletActions (escrituras)
  var _agw  = null;   // dirección de la smart wallet AGW
  var _eoa  = null;   // dirección EOA del firmante

  // Caché de módulos ESM ya descargados
  var _viem        = null;
  var _viemChains  = null;
  var _viemZksync  = null;
  var _agwWebLoaded = false;

  // ── Loaders lazy ─────────────────────────────────────────────────────────

  function _loadViem() {
    if (_viem) return Promise.resolve(_viem);
    return import("https://esm.sh/viem").then(function (m) { _viem = m; return m; });
  }

  function _loadChains() {
    if (_viemChains) return Promise.resolve(_viemChains);
    return import("https://esm.sh/viem/chains").then(function (m) { _viemChains = m; return m; });
  }

  function _loadViemZksync() {
    if (_viemZksync) return Promise.resolve(_viemZksync);
    return import("https://esm.sh/viem/zksync").then(function (m) { _viemZksync = m; return m; });
  }

  // Carga agw-web/testnet: al importarse, anuncia AGW como proveedor EIP-6963.
  // No-fatal: si falla (p. ej. Privy bloqueado), se usa window.ethereum como fallback.
  function _loadAgwWeb() {
    if (_agwWebLoaded) return Promise.resolve();
    return import("https://esm.sh/@abstract-foundation/agw-web/testnet")
      .then(function () { _agwWebLoaded = true; })
      .catch(function (e) {
        console.warn("[PengPool] agw-web no se pudo cargar (se usará window.ethereum):", e.message);
      });
  }

  // ── Descubrimiento de proveedor AGW vía EIP-6963 ─────────────────────────
  // Emite eip6963:requestProvider y espera el anuncio del proveedor AGW.
  // Devuelve el proveedor EIP-1193 de AGW, o null si no se encuentra.

  function _discoverAgwProvider() {
    return new Promise(function (resolve) {
      var found = null;

      function onAnnounce(evt) {
        var detail = evt.detail;
        if (!detail || !detail.info || !detail.provider) return;
        var rdns = detail.info.rdns || "";
        var name = (detail.info.name || "").toLowerCase();
        // rdns conocido: "xyz.abs.privy" — también aceptamos cualquier proveedor con "abstract"
        if (!found && (rdns === "xyz.abs.privy" || name.includes("abstract"))) {
          found = detail.provider;
        }
      }

      window.addEventListener("eip6963:announceProvider", onAnnounce);
      window.dispatchEvent(new Event("eip6963:requestProvider"));

      // 500 ms es suficiente para que el proveedor responda al request
      setTimeout(function () {
        window.removeEventListener("eip6963:announceProvider", onAnnounce);
        resolve(found);
      }, 500);
    });
  }

  // ── Public client (lecturas sin wallet) ───────────────────────────────────

  function _ensurePub() {
    if (_pub) return Promise.resolve(_pub);
    return Promise.all([_loadViem(), _loadChains()]).then(function (res) {
      var viem = res[0], chains = res[1];
      _pub = viem.createPublicClient({
        chain:     chains.abstractTestnet,
        transport: viem.http("https://api.testnet.abs.xyz"),
      });
      return _pub;
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _extractRevert(err) {
    var raw = (err && (err.shortMessage || err.message)) || String(err);
    var m = raw.match(/reverted with reason string '(.+?)'/);
    return m ? m[1] : raw;
  }

  function _fail(ctx, err) {
    throw new Error("[PengPool] " + ctx + ": " + _extractRevert(err));
  }

  // ── connectWallet ─────────────────────────────────────────────────────────
  //
  // 1. Carga agw-web/testnet para registrar el proveedor AGW (EIP-6963).
  // 2. Descubre el proveedor AGW. Fallback a window.ethereum (MetaMask).
  // 3. Llama eth_requestAccounts → abre el modal de login de AGW (o MetaMask).
  // 4. Crea walletClient con eip712WalletActions() para firmar en Abstract/ZKSync.

  function connectWallet() {
    return Promise.all([_loadViem(), _loadChains(), _loadViemZksync(), _loadAgwWeb()])
      .then(function (res) {
        var viem = res[0], chains = res[1], viemZksync = res[2];

        return _discoverAgwProvider().then(function (agwProv) {
          var provider = agwProv || window.ethereum || null;

          if (!provider) {
            throw new Error(
              "[PengPool] No se detectó wallet. Abre la app en Abstract o instala MetaMask."
            );
          }

          // AGW puede tardar en inicializarse tras la aprobación del modal.
          // Reintenta eth_requestAccounts hasta 3 veces con 1 s de espera si devuelve vacío.
          function _requestWithRetry(retriesLeft) {
            return provider.request({ method: "eth_requestAccounts" })
              .then(function (accounts) {
                if ((!accounts || !accounts.length) && retriesLeft > 0) {
                  console.warn("[PengPool] eth_requestAccounts vacío, reintentando (" + retriesLeft + " left)…");
                  return new Promise(function (resolve) { setTimeout(resolve, 1000); })
                    .then(function () { return _requestWithRetry(retriesLeft - 1); });
                }
                return accounts;
              });
          }

          return _requestWithRetry(3)
            .then(function (accounts) {
              if (!accounts || !accounts.length) throw new Error("No se recibieron cuentas.");
              // accounts[0] = AGW smart wallet; accounts[1] = EOA (si está disponible)
              _agw = accounts[0];
              _eoa = accounts[1] || accounts[0];

              _abs = viem.createWalletClient({
                account:   _agw,
                chain:     chains.abstractTestnet,
                transport: viem.custom(provider),
              }).extend(viemZksync.eip712WalletActions());

              if (!_pub) {
                _pub = viem.createPublicClient({
                  chain:     chains.abstractTestnet,
                  transport: viem.http("https://api.testnet.abs.xyz"),
                });
              }

              console.log("[PengPool] Conectado — EOA:", _eoa, "| AGW:", _agw);
              return { eoa: _eoa, agw: _agw };
            });
        });
      })
      .catch(function (err) {
        if (err && err.code === 4001) throw new Error("[PengPool] Conexión rechazada por el usuario.");
        _fail("connectWallet", err);
      });
  }

  // ── Lecturas ──────────────────────────────────────────────────────────────

  function getOpenGames() {
    return _ensurePub().then(function (pub) {
      return pub.readContract({
        address: PENGPOOL_ADDRESS, abi: PENGPOOL_ABI, functionName: "getOpenGames",
      });
    }).catch(function (err) { _fail("getOpenGames", err); });
  }

  function getGame(gameId) {
    return _ensurePub().then(function (pub) {
      return pub.readContract({
        address: PENGPOOL_ADDRESS, abi: PENGPOOL_ABI, functionName: "getGame",
        args: [BigInt(gameId)],
      });
    }).catch(function (err) { _fail("getGame", err); });
  }

  function betAmountWei(usdAmount) {
    if (![1,2,5,10].includes(usdAmount))
      return Promise.reject(new Error("[PengPool] betAmountWei: usdAmount must be 1, 2, 5, or 10."));
    return _ensurePub().then(function (pub) {
      return pub.readContract({
        address: PENGPOOL_ADDRESS, abi: PENGPOOL_ABI, functionName: "betAmountWei",
        args: [usdAmount],
      });
    }).catch(function (err) { _fail("betAmountWei", err); });
  }

  // ── Escrituras (requieren AGW conectado) ──────────────────────────────────

  function _requireAbs() {
    if (!_abs) throw new Error("[PengPool] Wallet no conectada. Llama connectWallet() primero.");
  }

  function createGame(betUSD) {
    try { _requireAbs(); } catch(e) { return Promise.reject(e); }
    if (![1,2,5,10].includes(betUSD))
      return Promise.reject(new Error("[PengPool] createGame: betUSD debe ser 1, 2, 5 o 10."));

    return betAmountWei(betUSD).then(function (value) {
      return _abs.writeContract({
        address: PENGPOOL_ADDRESS, abi: PENGPOOL_ABI, functionName: "createGame",
        args: [betUSD], value: value,
      });
    }).then(function (tx) {
      console.log("[PengPool] createGame tx:", tx); return tx;
    }).catch(function (err) { _fail("createGame", err); });
  }

  function joinGame(gameId) {
    try { _requireAbs(); } catch(e) { return Promise.reject(e); }

    return getGame(gameId).then(function (game) {
      if (Number(game.status) !== GameStatus.OPEN)
        throw new Error("La partida " + gameId + " no está abierta.");
      if (game.player1.toLowerCase() === _agw.toLowerCase())
        throw new Error("No puedes unirte a tu propia partida.");

      return _abs.writeContract({
        address: PENGPOOL_ADDRESS, abi: PENGPOOL_ABI, functionName: "joinGame",
        args: [BigInt(gameId)], value: game.betAmount,
      });
    }).then(function (tx) {
      console.log("[PengPool] joinGame tx:", tx); return tx;
    }).catch(function (err) { _fail("joinGame", err); });
  }

  function declareWinner(gameId, winner) {
    try { _requireAbs(); } catch(e) { return Promise.reject(e); }
    if (!winner || !/^0x[0-9a-fA-F]{40}$/.test(winner))
      return Promise.reject(new Error("[PengPool] declareWinner: dirección inválida."));

    return _abs.writeContract({
      address: PENGPOOL_ADDRESS, abi: PENGPOOL_ABI, functionName: "declareWinner",
      args: [BigInt(gameId), winner],
    }).then(function (tx) {
      console.log("[PengPool] declareWinner tx:", tx); return tx;
    }).catch(function (err) { _fail("declareWinner", err); });
  }

  function cancelGame(gameId) {
    try { _requireAbs(); } catch(e) { return Promise.reject(e); }

    return getGame(gameId).then(function (game) {
      if (Number(game.status) !== GameStatus.OPEN)
        throw new Error("La partida " + gameId + " no está abierta.");
      if (game.player1.toLowerCase() !== _agw.toLowerCase())
        throw new Error("Solo el creador puede cancelar esta partida.");

      return _abs.writeContract({
        address: PENGPOOL_ADDRESS, abi: PENGPOOL_ABI, functionName: "cancelGame",
        args: [BigInt(gameId)],
      });
    }).then(function (tx) {
      console.log("[PengPool] cancelGame tx:", tx); return tx;
    }).catch(function (err) { _fail("cancelGame", err); });
  }

  // ── formatEther helper (sin viem) ─────────────────────────────────────────

  function formatEther(wei) {
    if (typeof wei === "bigint") return (Number(wei) / 1e18).toFixed(6);
    if (typeof wei === "string") return (Number(BigInt(wei)) / 1e18).toFixed(6);
    return "0.000000";
  }

  // ── API pública — asignada SÍNCRONAMENTE al cargar el script ─────────────

  window.PengPoolWeb3 = Object.freeze({
    connectWallet:  connectWallet,
    getOpenGames:   getOpenGames,
    getGame:        getGame,
    betAmountWei:   betAmountWei,
    createGame:     createGame,
    joinGame:       joinGame,
    declareWinner:  declareWinner,
    cancelGame:     cancelGame,
    getAddress:     function () { return _agw; },
    getEOA:         function () { return _eoa; },
    isConnected:    function () { return _abs !== null; },
    GameStatus:     GameStatus,
    PENGPOOL_ADDRESS: PENGPOOL_ADDRESS,
    formatEther:    formatEther,
  });

  console.log("[PengPool] web3.js listo — window.PengPoolWeb3 disponible.");

  // Pre-cargas en background (no bloquean la UI):
  // - agw-web/testnet: registra el proveedor EIP-6963 de AGW para que esté listo al conectar
  // - publicClient: acelera las lecturas del matchmaking
  _loadAgwWeb();
  _ensurePub().catch(function (e) {
    console.warn("[PengPool] Pre-carga del publicClient falló:", e.message);
  });

})();
