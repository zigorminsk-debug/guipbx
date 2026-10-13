// Минимальный клиент AMI (Asterisk Manager Interface) без внешних зависимостей:
// TCP 5038 → Login → последовательные Command-действия → Logoff.
package main

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

const amiTimeout = 12 * time.Second

type AMIAction struct {
	Action  string
	Command string
}

// amiRun открывает соединение, выполняет actions и возвращает баннер + ответы.
func amiRun(host string, port int, user, secret string, actions []AMIAction) (string, []string, error) {
	if port <= 0 {
		port = 5038
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, port), 6*time.Second)
	if err != nil {
		return "", nil, fmt.Errorf("подключение к %s:%d: %w", host, port, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(amiTimeout + time.Duration(len(actions))*4*time.Second))

	rd := bufio.NewReader(conn)

	readBlock := func() (string, error) {
		var sb strings.Builder
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				return sb.String(), err
			}
			if line == "\r\n" {
				return sb.String(), nil
			}
			sb.WriteString(line)
		}
	}
	readBanner := func() (string, error) {
		line, err := rd.ReadString('\n')
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "Asterisk Call Manager/")), nil
	}
	send := func(pairs ...[2]string) error {
		var sb strings.Builder
		for _, p := range pairs {
			sb.WriteString(p[0] + ": " + p[1] + "\r\n")
		}
		sb.WriteString("\r\n")
		_, err := conn.Write([]byte(sb.String()))
		return err
	}

	banner, err := readBanner()
	if err != nil {
		return "", nil, fmt.Errorf("баннер AMI: %w", err)
	}

	if err := send([2]string{"Action", "Login"}, [2]string{"Username", user}, [2]string{"Secret", secret}); err != nil {
		return "", nil, err
	}
	resp, err := readBlock()
	if err != nil {
		return "", nil, fmt.Errorf("ответ Login: %w", err)
	}
	if !strings.Contains(resp, "Authentication accepted") {
		return "", nil, fmt.Errorf("аутентификация отклонена: %s", oneLine(resp))
	}

	responses := []string{}
	for i, a := range actions {
		aid := fmt.Sprintf("cmd%d", i)
		var snd error
		if a.Action == "Command" {
			snd = send([2]string{"Action", "Command"}, [2]string{"Command", a.Command}, [2]string{"ActionID", aid})
		} else {
			snd = send([2]string{"Action", a.Action}, [2]string{"ActionID", aid})
		}
		if snd != nil {
			return banner, responses, snd
		}

		// читаем блоки, пока не получим ответ на наш ActionID
		var sb strings.Builder
		for {
			blk, err := readBlock()
			if err != nil {
				return banner, responses, fmt.Errorf("команда %q: %w", a.Command, err)
			}
			if !strings.Contains(blk, "ActionID: "+aid) && sb.Len() == 0 && !strings.Contains(blk, "--END COMMAND--") {
				continue // стороннее событие
			}
			sb.WriteString(blk)
			if strings.Contains(blk, "--END COMMAND--") || (strings.Contains(blk, "ActionID: "+aid) && !strings.Contains(blk, "Response: Follows")) {
				break
			}
			if strings.Contains(blk, "Response: Follows") {
				continue // ждём блок с выводом и --END COMMAND--
			}
		}
		responses = append(responses, sb.String())
	}

	_ = send([2]string{"Action", "Logoff"})
	return banner, responses, nil
}

// amiOutput возвращает сырые строки вывода CLI-команды (без "Output: "-префиксов).
func amiOutput(block string) string {
	out := []string{}
	for _, l := range strings.Split(block, "\n") {
		l = strings.TrimRight(l, "\r")
		if strings.HasPrefix(l, "Output: ") {
			if o := strings.TrimPrefix(l, "Output: "); o != "--END COMMAND--" {
				out = append(out, o)
			}
		} else if strings.HasPrefix(l, "Output:") {
			if o := strings.TrimPrefix(l, "Output:"); o != "--END COMMAND--" {
				out = append(out, o)
			}
		}
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n")
}

// amiFriendly — компактное представление ответа для показа в UI.
func amiFriendly(cmd, block string) string {
	lines := []string{}
	for _, l := range strings.Split(block, "\n") {
		l = strings.TrimRight(l, "\r")
		switch {
		case strings.HasPrefix(l, "Output: "):
			if s := strings.TrimSpace(strings.TrimPrefix(l, "Output: ")); s != "" {
				lines = append(lines, s)
			}
		case strings.HasPrefix(l, "Message:"):
			lines = append(lines, strings.TrimSpace(strings.TrimPrefix(l, "Message:")))
		case strings.HasPrefix(l, "Response: Error"), strings.HasPrefix(l, "Response: Fail"):
			lines = append(lines, strings.TrimSpace(l))
		}
	}
	if len(lines) == 0 {
		return cmd + " → OK"
	}
	const max = 240
	text := cmd + " → " + strings.Join(lines, " | ")
	if len(text) > max {
		text = text[:max] + "…"
	}
	return text
}

func oneLine(block string) string {
	for _, l := range strings.Split(block, "\n") {
		if strings.HasPrefix(l, "Message:") {
			return strings.TrimSpace(strings.TrimPrefix(l, "Message:"))
		}
	}
	parts := strings.FieldsFunc(strings.TrimSpace(block), func(r rune) bool { return r == '\r' || r == '\n' })
	if len(parts) == 0 {
		return "(пустой ответ)"
	}
	return parts[0]
}

func amiTest(host string, port int, user, secret string) (string, error) {
	banner, _, err := amiRun(host, port, user, secret, nil)
	return banner, err
}

// ── сессия подключения к станции ────────────────────────────

type stationSession struct {
	Host        string    `json:"host"`
	Port        int       `json:"port"`
	User        string    `json:"user"`
	Secret      string    `json:"-"`
	Banner      string    `json:"banner"`
	ConnectedAt time.Time `json:"connectedAt"`
}

var station = struct {
	sync.RWMutex
	sess *stationSession
}{}

func currentStation() *stationSession {
	station.RLock()
	defer station.RUnlock()
	return station.sess
}

func setStation(s *stationSession) {
	station.Lock()
	station.sess = s
	station.Unlock()
}

// amiOnStation выполняет команды на текущей станции.
func amiOnStation(commands []string) ([]string, error) {
	s := currentStation()
	if s == nil {
		return nil, fmt.Errorf("нет подключения к станции")
	}
	acts := make([]AMIAction, 0, len(commands))
	for _, c := range commands {
		acts = append(acts, AMIAction{Action: "Command", Command: c})
	}
	_, responses, err := amiRun(s.Host, s.Port, s.User, s.Secret, acts)
	return responses, err
}
