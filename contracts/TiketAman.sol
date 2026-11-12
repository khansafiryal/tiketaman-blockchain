// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title  TiketAman - token tiket event anti-calo (ERC-721)
 * @notice Setiap tiket adalah token unik. Aturan yang dikunci di kontrak:
 *         (1) mint hanya oleh server (OPERATOR_ROLE) setelah pembayaran terverifikasi,
 *         (2) satu orderRef hanya bisa dipakai sekali (idempotensi on-chain),
 *         (3) batas kepemilikan tiket per alamat per event,
 *         (4) transfer langsung antar-wallet dinonaktifkan; kepemilikan hanya berpindah
 *             lewat penjualan ulang resmi yang harganya dibatasi terhadap harga nominal,
 *         (5) tiket ditandai terpakai saat check-in dan tidak bisa dipakai dua kali.
 * @dev    Harga dicatat dalam rupiah (bilangan bulat). Dana tidak berpindah di kontrak;
 *         pembayaran rupiah diproses payment gateway berizin. Prototipe berjalan di testnet.
 */
contract TiketAman is ERC721, AccessControl, Pausable {
    // ------------------------------------------------------------------ roles
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");   // backend server
    bytes32 public constant ORGANIZER_ROLE = keccak256("ORGANIZER_ROLE"); // pembuat event
    bytes32 public constant GATE_ROLE = keccak256("GATE_ROLE");           // pemindai check-in

    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_RESALE_CAP_BPS = 15_000; // batas atas absolut: 150% harga nominal

    // ------------------------------------------------------------------ data
    struct EventInfo {
        address organizer;
        uint128 faceValue;        // harga nominal (Rp)
        uint32 supply;            // jumlah tiket maksimum
        uint32 minted;            // jumlah tiket yang sudah dicetak
        uint16 maxResaleBps;      // mis. 11000 = 110% harga nominal
        uint16 organizerShareBps; // bagian penyelenggara dari selisih harga resale
        uint8 maxPerAddress;      // mis. 4 tiket per alamat
        bool exists;
    }

    struct Ticket {
        uint256 eventId;
        uint128 lastPrice;   // harga transaksi terakhir (Rp)
        bool used;           // sudah check-in
    }

    mapping(uint256 => EventInfo) private _events;
    mapping(uint256 => Ticket) private _tickets;
    mapping(uint256 => mapping(address => uint256)) public holdings; // eventId => alamat => jumlah tiket
    mapping(bytes32 => bool) public processedOrders;                   // idempotensi orderRef
    mapping(uint256 => uint128) public listings;                       // tokenId => harga listing (0 = tidak dijual)

    uint256 private _nextTokenId = 1;
    bool private _officialTransfer; // true hanya selama mint atau resale resmi

    // ------------------------------------------------------------------ events
    event EventCreated(uint256 indexed eventId, address indexed organizer, uint128 faceValue,
        uint32 supply, uint16 maxResaleBps, uint8 maxPerAddress);
    event TicketMinted(uint256 indexed tokenId, uint256 indexed eventId, address indexed to, bytes32 orderRef);
    event TicketListed(uint256 indexed tokenId, uint128 price);
    event ListingCancelled(uint256 indexed tokenId);
    event ResaleExecuted(uint256 indexed tokenId, address indexed from, address indexed to,
        uint128 price, uint128 organizerShare, bytes32 orderRef);
    event CheckedIn(uint256 indexed tokenId, address indexed holder, address indexed gate);

    // ------------------------------------------------------------------ errors
    error InvalidConfig();
    error EventAlreadyExists(uint256 eventId);
    error EventNotFound(uint256 eventId);
    error SoldOut(uint256 eventId);
    error PurchaseLimitExceeded(address account, uint256 eventId);
    error OrderAlreadyProcessed(bytes32 orderRef);
    error PriceAboveCap(uint128 price, uint128 cap);
    error TicketAlreadyUsed(uint256 tokenId);
    error TransferDisabled();
    error NotListed(uint256 tokenId);
    error NotTicketHolder(uint256 tokenId, address account);

    constructor(address admin, address operator) ERC721("TiketAman Ticket", "TKA") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
    }

    // ================================================================ event
    /// @notice Membuat event. Batas harga resale dan kuota dikunci (tidak ada fungsi untuk mengubahnya).
    function createEvent(
        uint256 eventId,
        uint128 faceValue,
        uint32 supply,
        uint16 maxResaleBps,
        uint16 organizerShareBps,
        uint8 maxPerAddress
    ) external onlyRole(ORGANIZER_ROLE) {
        if (_events[eventId].exists) revert EventAlreadyExists(eventId);
        if (faceValue == 0 || supply == 0 || maxPerAddress == 0) revert InvalidConfig();
        if (maxResaleBps < BPS || maxResaleBps > MAX_RESALE_CAP_BPS) revert InvalidConfig();
        if (organizerShareBps > BPS) revert InvalidConfig();

        _events[eventId] = EventInfo({
            organizer: msg.sender,
            faceValue: faceValue,
            supply: supply,
            minted: 0,
            maxResaleBps: maxResaleBps,
            organizerShareBps: organizerShareBps,
            maxPerAddress: maxPerAddress,
            exists: true
        });
        emit EventCreated(eventId, msg.sender, faceValue, supply, maxResaleBps, maxPerAddress);
    }

    // ================================================================ primary sale
    /// @notice Dipanggil server setelah webhook pembayaran terverifikasi.
    function mintTicket(uint256 eventId, address buyer, bytes32 orderRef)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        returns (uint256 tokenId)
    {
        EventInfo storage ev = _events[eventId];
        if (!ev.exists) revert EventNotFound(eventId);
        if (processedOrders[orderRef]) revert OrderAlreadyProcessed(orderRef);
        if (ev.minted >= ev.supply) revert SoldOut(eventId);
        if (holdings[eventId][buyer] + 1 > ev.maxPerAddress) revert PurchaseLimitExceeded(buyer, eventId);

        processedOrders[orderRef] = true;
        ev.minted += 1;
        tokenId = _nextTokenId++;
        _tickets[tokenId] = Ticket({eventId: eventId, lastPrice: ev.faceValue, used: false});

        _officialTransfer = true;
        _safeMint(buyer, tokenId);
        _officialTransfer = false;

        emit TicketMinted(tokenId, eventId, buyer, orderRef);
    }

    // ================================================================ resale
    /// @notice Harga maksimum resale = faceValue x maxResaleBps / 10000 (selalu terhadap harga nominal).
    function resaleCap(uint256 tokenId) public view returns (uint128) {
        EventInfo storage ev = _events[_tickets[tokenId].eventId];
        return uint128((uint256(ev.faceValue) * ev.maxResaleBps) / BPS);
    }

    /// @notice Pemilik (atau operator atas nama wallet custodial) memasang tiket untuk dijual ulang.
    function listForResale(uint256 tokenId, uint128 price) external whenNotPaused {
        address holder = _requireOwned(tokenId);
        if (msg.sender != holder && !hasRole(OPERATOR_ROLE, msg.sender)) revert NotTicketHolder(tokenId, msg.sender);
        if (_tickets[tokenId].used) revert TicketAlreadyUsed(tokenId);
        uint128 cap = resaleCap(tokenId);
        if (price == 0 || price > cap) revert PriceAboveCap(price, cap);

        listings[tokenId] = price;
        emit TicketListed(tokenId, price);
    }

    function cancelListing(uint256 tokenId) external {
        address holder = _requireOwned(tokenId);
        if (msg.sender != holder && !hasRole(OPERATOR_ROLE, msg.sender)) revert NotTicketHolder(tokenId, msg.sender);
        if (listings[tokenId] == 0) revert NotListed(tokenId);
        delete listings[tokenId];
        emit ListingCancelled(tokenId);
    }

    /// @notice Dipanggil server setelah pembayaran pembeli resale terverifikasi.
    function executeResale(uint256 tokenId, address buyer, bytes32 orderRef)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
    {
        uint128 price = listings[tokenId];
        if (price == 0) revert NotListed(tokenId);
        if (processedOrders[orderRef]) revert OrderAlreadyProcessed(orderRef);
        Ticket storage t = _tickets[tokenId];
        if (t.used) revert TicketAlreadyUsed(tokenId);
        EventInfo storage ev = _events[t.eventId];
        if (holdings[t.eventId][buyer] + 1 > ev.maxPerAddress) revert PurchaseLimitExceeded(buyer, t.eventId);

        address seller = ownerOf(tokenId);
        processedOrders[orderRef] = true;
        delete listings[tokenId];

        uint128 markup = price > ev.faceValue ? price - ev.faceValue : 0;
        uint128 organizerShare = uint128((uint256(markup) * ev.organizerShareBps) / BPS);
        t.lastPrice = price;

        _officialTransfer = true;
        _safeTransfer(seller, buyer, tokenId, "");
        _officialTransfer = false;

        emit ResaleExecuted(tokenId, seller, buyer, price, organizerShare, orderRef);
    }

    // ================================================================ check-in
    function checkIn(uint256 tokenId, address holder) external onlyRole(GATE_ROLE) whenNotPaused {
        address owner = _requireOwned(tokenId);
        if (owner != holder) revert NotTicketHolder(tokenId, holder);
        Ticket storage t = _tickets[tokenId];
        if (t.used) revert TicketAlreadyUsed(tokenId);
        t.used = true;
        delete listings[tokenId];
        emit CheckedIn(tokenId, holder, msg.sender);
    }

    // ================================================================ admin
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ================================================================ views
    function getEventInfo(uint256 eventId) external view returns (EventInfo memory) {
        if (!_events[eventId].exists) revert EventNotFound(eventId);
        return _events[eventId];
    }

    function getTicket(uint256 tokenId) external view returns (Ticket memory) {
        _requireOwned(tokenId);
        return _tickets[tokenId];
    }

    // ================================================================ transfer guard
    /// @dev Semua perpindahan token melewati _update (OZ v5). Transfer di luar mint/resale resmi ditolak.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        if (!_officialTransfer) revert TransferDisabled();
        from = super._update(to, tokenId, auth);
        uint256 eventId = _tickets[tokenId].eventId;
        if (from != address(0)) holdings[eventId][from] -= 1;
        if (to != address(0)) holdings[eventId][to] += 1;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
