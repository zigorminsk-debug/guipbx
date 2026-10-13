package main

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"testing"
)

// fakeAMI — эмулятор Asterisk Manager Interface для тестов без живой станции.
func fakeAMI(t *testing.T, dumpText string) (host string, port int, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handleAMI(conn, dumpText)
		}
	}()
	parts := strings.Split(ln.Addr().String(), ":")
	return parts[0], atoi(parts[len(parts)-1]), func() { _ = ln.Close() }
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		}
	}
	return n
}

func handleAMI(conn net.Conn, dumpText string) {
	defer conn.Close()
	_, _ = fmt.Fprint(conn, "Asterisk Call Manager/9.9-test\r\n")
	rd := bufio.NewReader(conn)
	readBlock := func() string {
		var sb strings.Builder
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				return sb.String()
			}
			if line == "\r\n" {
				return sb.String()
			}
			sb.WriteString(line)
		}
	}
	for {
		blk := readBlock()
		if blk == "" {
			return
		}
		switch {
		case strings.Contains(blk, "Action: Login"):
			if strings.Contains(blk, "Secret: good") {
				_, _ = fmt.Fprintf(conn, "Response: Success\r\nMessage: Authentication accepted\r\n\r\n")
			} else {
				_, _ = fmt.Fprintf(conn, "Response: Error\r\nMessage: Authentication failed\r\n\r\n")
				return
			}
		case strings.Contains(blk, "Action: Logoff"):
			_, _ = fmt.Fprintf(conn, "Response: Goodbye\r\n\r\n")
			return
		case strings.Contains(blk, "Command: dialplan show"):
			aid := fieldOf(blk, "ActionID")
			var sb strings.Builder
			sb.WriteString("Response: Follows\r\nPrivilege: Command\r\nActionID: " + aid + "\r\n")
			for _, l := range strings.Split(strings.TrimRight(dumpText, "\n"), "\n") {
				sb.WriteString("Output: " + l + "\r\n")
			}
			sb.WriteString("Output: --END COMMAND--\r\n\r\n")
			_, _ = fmt.Fprint(conn, sb.String())
		case strings.Contains(blk, "Action: Command"):
			aid := fieldOf(blk, "ActionID")
			cmd := fieldOf(blk, "Command")
			if strings.HasPrefix(cmd, "dialplan remove context nope") {
				_, _ = fmt.Fprintf(conn, "Response: Error\r\nMessage: Context 'nope' not found\r\nActionID: %s\r\n\r\n", aid)
			} else {
				_, _ = fmt.Fprintf(conn, "Response: Success\r\nActionID: %s\r\n\r\n", aid)
			}
		}
	}
}

func fieldOf(block, key string) string {
	for _, l := range strings.Split(block, "\n") {
		l = strings.TrimRight(l, "\r")
		if strings.HasPrefix(l, key+": ") {
			return strings.TrimSpace(strings.TrimPrefix(l, key+": "))
		}
	}
	return ""
}

func TestAMIAuthFail(t *testing.T) {
	host, port, stop := fakeAMI(t, "")
	defer stop()
	_, err := amiTest(host, port, "admin", "badsecret")
	if err == nil {
		t.Fatal("ожидалась ошибка аутентификации")
	}
}

func TestAMICommands(t *testing.T) {
	dump := "\n[ Context 'x' created by 'pbx_config' ]\n  's' => 1. Answer()\n"
	host, port, stop := fakeAMI(t, dump)
	defer stop()

	banner, responses, err := amiRun(host, port, "admin", "good", []AMIAction{
		{Action: "Command", Command: "dialplan show"},
		{Action: "Command", Command: "dialplan remove context x"},
		{Action: "Command", Command: "dialplan reload"},
	})
	if err != nil {
		t.Fatalf("amiRun: %v", err)
	}
	if banner != "9.9-test" {
		t.Errorf("баннер: %q", banner)
	}
	if len(responses) != 3 {
		t.Fatalf("ответов: %d", len(responses))
	}
	out := amiOutput(responses[0])
	if !strings.Contains(out, "'s' => 1. Answer()") {
		t.Errorf("вывод dialplan show искажён: %q", out)
	}
	if f := amiFriendly("dialplan reload", responses[2]); f != "dialplan reload → OK" {
		t.Errorf("friendly: %q", f)
	}
}

func TestAMITimeout(t *testing.T) {
	host, port, stop := fakeAMI(t, "")
	stop() // сразу закрываем — соединение должно отвалиться
	_, err := amiTest(host, port, "a", "b")
	if err == nil {
		t.Fatal("ожидалась ошибка соединения")
	}
}
